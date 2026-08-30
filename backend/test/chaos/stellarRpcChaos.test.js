"use strict";

/**
 * backend/test/chaos/stellarRpcChaos.test.js
 *
 * Chaos scenarios for the unified Stellar submission pipeline (#1098 W1).
 *
 * SAFETY: The entire suite is guarded by CHAOS_TEST=1 (same as
 * workerChaos.test.js). The CI `chaos` job sets this flag; plain `npm test`
 * never sets it, so these tests are skipped in the normal Jest run.
 *
 * Scenarios (simulated RPC / Horizon outage)
 * ───────────────────────────────────────────
 *   A. Sustained RPC 5xx outage → circuit breaker trips after 5 failures →
 *      subsequent submissions fail fast with CIRCUIT_OPEN and ZERO network
 *      calls (no hammering a dead endpoint, no hang).
 *   B. Reads while the circuit is open → fail fast (breaker rejection in
 *      <2s, well under any request timeout) or degrade to empty results —
 *      nothing hangs.
 *   C. Recovery: after the breaker cooldown elapses it half-opens, the next
 *      submission succeeds, and the breaker re-closes.
 *   D. Fee-bump escalation under RPC outage → typed error, bounded time, no
 *      infinite retry loop.
 *   E. Long-lived stream (SSE-style) breaker integration: repeated
 *      `recordFailure` callbacks trip the breaker; `recordSuccess` recovers
 *      it through half-open (the pattern indexerService.js uses for the
 *      Horizon SSE stream).
 *
 * Invariants asserted per scenario
 * ────────────────────────────────
 *   • No unbounded retry loops / no hangs (every scenario bounds wall time)
 *   • No network call after the breaker opens (fail-fast)
 *   • Typed error codes (CIRCUIT_OPEN / TX_TRANSIENT_EXHAUSTED / …) so
 *     operators can alert on the failure class
 *   • Automatic recovery after cooldown without operator intervention
 *
 * Local execution
 * ───────────────
 *   CHAOS_TEST=1 npx jest --testPathPattern="stellarRpcChaos" --forceExit
 */

const CHAOS_ENABLED = Boolean(process.env.CHAOS_TEST);

// Shared fault-injectable RPC / Horizon servers. The jest factory below
// closes over these (the `mock` prefix is what jest's babel plugin keeps in
// scope inside the factory).
const mockRpcServer = {
  sendTransaction: jest.fn(),
  getTransaction: jest.fn(),
  getEvents: jest.fn(),
  getLatestLedger: jest.fn(),
  simulateTransaction: jest.fn(),
};

const mockHorizonServer = {
  loadAccount: jest.fn(),
  fetchBaseFee: jest.fn(),
  submitTransaction: jest.fn(),
  transactions: jest.fn(),
  ledgers: jest.fn(),
  operations: jest.fn(),
};

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    rpc: { ...actual.rpc, Server: jest.fn(() => mockRpcServer) },
    Horizon: { ...actual.Horizon, Server: jest.fn(() => mockHorizonServer) },
  };
});

jest.mock("../../src/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const stellar = require("../../src/services/stellar");
const { CircuitBreaker } = require("../../src/services/circuitBreaker");
const {
  Keypair,
  Account,
  TransactionBuilder,
  Networks,
  Asset,
  Operation,
} = require("@stellar/stellar-sdk");

const PAYMENT_DESTINATION =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function buildSignedTx() {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), "123456");
  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: PAYMENT_DESTINATION,
        asset: Asset.native(),
        amount: "10",
      }),
    )
    .setTimeout(60)
    .build();
  tx.sign(keypair);
  return { xdr: tx.toXDR(), hash: tx.hash().toString("hex"), keypair };
}

const describeChaos = CHAOS_ENABLED ? describe : describe.skip;

describeChaos(
  "chaos: unified submission pipeline under simulated RPC failure (#1098 W1)",
  () => {
    const { rpcBreaker } = stellar;
    let tx;

    beforeEach(() => {
      jest.clearAllMocks();
      Object.values(mockRpcServer).forEach((fn) => fn.mockReset());
      Object.values(mockHorizonServer).forEach((fn) => fn.mockReset());
      rpcBreaker.reset();
      tx = buildSignedTx();
    });

    test("A: sustained RPC 5xx outage trips the breaker; submissions fail fast with CIRCUIT_OPEN and zero network calls", async () => {
      mockRpcServer.sendTransaction.mockRejectedValue(
        new Error("rpc error 500: internal server error"),
      );

      // 5 consecutive failures → breaker opens.
      for (let i = 0; i < 5; i++) {
        await expect(
          stellar.submitTransactionSafe(tx.xdr, { maxRetries: 0 }),
        ).rejects.toMatchObject({ code: "TX_TRANSIENT_EXHAUSTED" });
      }
      expect(rpcBreaker.getState()).toBe("open");

      // 6th submission → fail fast, no network call, bounded wall time.
      mockRpcServer.sendTransaction.mockClear();
      const start = Date.now();
      await expect(
        stellar.submitTransactionSafe(tx.xdr),
      ).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
      expect(Date.now() - start).toBeLessThan(2000);
      expect(mockRpcServer.sendTransaction).not.toHaveBeenCalled();
    });

    test("B: reads while the circuit is open fail fast or degrade to empty results — nothing hangs", async () => {
      // Trip the breaker.
      for (let i = 0; i < 5; i++) {
        await expect(
          rpcBreaker.call(() => {
            throw new Error("rpc error 500");
          }),
        ).rejects.toThrow();
      }
      expect(rpcBreaker.getState()).toBe("open");

      // Event ingestion degrades to an empty batch (graceful, not a crash).
      const readStart = Date.now();
      await expect(stellar.getProjectDonationEvents("project-1")).resolves.toEqual([]);
      expect(Date.now() - readStart).toBeLessThan(2000);

      // Readiness-style RPC probe fails fast with the breaker rejection.
      const probeStart = Date.now();
      await expect(
        stellar.withRetry(() => mockRpcServer.getLatestLedger(), 1),
      ).rejects.toThrow(/Circuit breaker/);
      expect(Date.now() - probeStart).toBeLessThan(2000);
    });

    test("C: breaker recovers through half-open after cooldown; first success re-closes it", async () => {
      for (let i = 0; i < 5; i++) {
        await expect(
          rpcBreaker.call(() => {
            throw new Error("rpc error 500");
          }),
        ).rejects.toThrow();
      }
      expect(rpcBreaker.getState()).toBe("open");

      jest.useFakeTimers();
      try {
        jest.advanceTimersByTime(31_000); // past resetTimeout → half-open on next call

        mockRpcServer.sendTransaction.mockResolvedValueOnce({
          status: "PENDING",
          hash: tx.hash,
        });
        mockRpcServer.getTransaction.mockResolvedValueOnce({
          status: "SUCCESS",
          ledger: 99,
        });

        const result = await stellar.submitTransactionSafe(tx.xdr, {
          pollIntervalMs: 1,
          pollTimeoutMs: 2000,
        });

        expect(result.status).toBe("SUCCESS");
        expect(result.ledger).toBe(99);
        expect(rpcBreaker.getState()).toBe("closed");
      } finally {
        jest.useRealTimers();
      }
    });

    test("D: fee-bump escalation under RPC outage ends in a typed error within bounded time", async () => {
      // Original submission is accepted (PENDING) but never confirms; the
      // fee-bump re-submission then hits the RPC outage.
      mockRpcServer.sendTransaction
        .mockResolvedValueOnce({ status: "PENDING", hash: tx.hash })
        .mockRejectedValue(new Error("rpc error 500: internal server error"));
      mockRpcServer.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });

      const start = Date.now();
      await expect(
        stellar.submitTransactionSafe(tx.xdr, {
          pollIntervalMs: 2,
          pollTimeoutMs: 15,
          maxRetries: 1,
          feeBump: { keypair: tx.keypair, maxAttempts: 1 },
        }),
      ).rejects.toMatchObject({ code: "TX_TRANSIENT_EXHAUSTED" });

      // 15ms poll window + at most one 100-350ms jittered backoff — far below
      // any request timeout; proves no infinite retry loop.
      expect(Date.now() - start).toBeLessThan(5000);
    });

    test("E: SSE-style breaker integration — repeated recordFailure callbacks trip it, recordSuccess recovers it", async () => {
      // Mirrors indexerService.js's Horizon SSE wiring: stream errors arrive
      // as callbacks (recordFailure) and a successful stream open re-closes
      // the breaker (recordSuccess).
      const breaker = new CircuitBreaker({
        name: "chaos_sse",
        failureThreshold: 5,
        resetTimeout: 30_000,
      });

      for (let i = 0; i < 5; i++) {
        breaker.recordFailure(new Error("Horizon SSE stream error"));
      }
      expect(breaker.getState()).toBe("open");

      // A stream open while OPEN fails fast (no network attempt).
      await expect(
        breaker.call(async () => "stream-opened"),
      ).rejects.toThrow(/OPEN/);

      // After cooldown the next attempt half-opens and succeeds → re-closed.
      jest.useFakeTimers();
      try {
        jest.advanceTimersByTime(31_000);
        await expect(
          breaker.call(async () => "stream-opened"),
        ).resolves.toBe("stream-opened");
        expect(breaker.getState()).toBe("closed");
      } finally {
        jest.useRealTimers();
      }
    });
  },
);
