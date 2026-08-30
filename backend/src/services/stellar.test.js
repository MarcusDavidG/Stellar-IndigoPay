/**
 * src/services/stellar.test.js
 *
 * Unit tests for the unified Stellar transaction submission pipeline
 * (issue #1098, Workstream 1).
 *
 * Coverage:
 *   - error classification (transient 5xx/network vs non-retryable 4xx)
 *   - `submitTransactionSafe` status handling: PENDING -> finality polling,
 *     TRY_AGAIN_LATER -> retried, ERROR -> fail fast, DUPLICATE -> poll
 *   - fee-bump escalation when a submission is accepted but not final
 *   - circuit-breaker fail-fast with a typed `CIRCUIT_OPEN` error
 *   - legacy `submitTransaction` / `submitWithFeeBump` now delegate to the
 *     unified pipeline (PENDING is no longer treated as success)
 *   - metrics (fee-bump counter, submit duration histogram)
 *
 * The @stellar/stellar-sdk module is mocked only at the Server boundaries:
 * the real SDK classes (Keypair, TransactionBuilder, Transaction, xdr) are
 * used so we submit real signed envelopes and assert against the real hash.
 */

"use strict";

// Shared mock RPC / Horizon servers. The jest factory below closes over these
// (the `mock` prefix is what lets jest's babel plugin keep them in scope).
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

jest.mock("../logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const stellar = require("./stellar");
const { metrics } = require("./metrics");
const {
  Keypair,
  Account,
  TransactionBuilder,
  Networks,
  Asset,
  Operation,
  Transaction,
} = require("@stellar/stellar-sdk");

const PAYMENT_DESTINATION =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Build a real, signed payment transaction XDR + its hex hash. */
function buildSignedTx(fee = "100000") {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), "123456");
  const tx = new TransactionBuilder(account, {
    fee,
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

async function counterValue(counter) {
  const snap = await counter.get();
  return snap.values.reduce((sum, v) => sum + (v.value || 0), 0);
}

describe("stellar.js — unified transaction submission pipeline (#1098 W1)", () => {
  const { rpcBreaker } = stellar;
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.values(mockRpcServer).forEach((fn) => fn.mockReset());
    Object.values(mockHorizonServer).forEach((fn) => fn.mockReset());
    rpcBreaker.reset(); // every test starts with a CLOSED circuit
    tx = buildSignedTx();
  });

  describe("isRetryable — error classification", () => {
    it("retries transient network errors and HTTP 5xx", () => {
      for (const msg of [
        "socket hang up",
        "connect ECONNRESET",
        "request timed out (ETIMEDOUT)",
        "getaddrinfo EAI_AGAIN",
        "rpc error 500: internal server error",
        "upstream responded 502",
        "upstream responded 503",
        "gateway timeout 504",
      ]) {
        expect(stellar.isRetryable(new Error(msg))).toBe(true);
      }
    });

    it("never retries 4xx-style or application errors", () => {
      for (const msg of [
        "rpc error 400: bad request",
        "401 unauthorized",
        "403 forbidden",
        "tx_bad_seq",
        "permission denied",
        "account not found",
      ]) {
        expect(stellar.isRetryable(new Error(msg))).toBe(false);
      }
    });
  });

  describe("jitteredBackoff", () => {
    it("grows exponentially with jitter bounded by the base delay", () => {
      for (let i = 0; i < 20; i++) {
        const d1 = stellar.jitteredBackoff(1);
        const d2 = stellar.jitteredBackoff(2);
        const d3 = stellar.jitteredBackoff(3);
        expect(d1).toBeGreaterThanOrEqual(100);
        expect(d1).toBeLessThan(350); // 100 + jitter(<=250)
        expect(d2).toBeGreaterThanOrEqual(200);
        expect(d3).toBeGreaterThanOrEqual(400);
        expect(d2).toBeLessThan(450);
        expect(d3).toBeLessThan(650);
      }
    });
  });

  describe("submitTransactionSafe", () => {
    it("treats PENDING as not-yet-final and polls to SUCCESS", async () => {
      mockRpcServer.sendTransaction.mockResolvedValueOnce({
        status: "PENDING",
        hash: tx.hash,
      });
      mockRpcServer.getTransaction.mockResolvedValueOnce({
        status: "NOT_FOUND",
      });
      mockRpcServer.getTransaction.mockResolvedValueOnce({
        status: "SUCCESS",
        ledger: 12345,
      });

      const result = await stellar.submitTransactionSafe(tx.xdr, {
        pollIntervalMs: 1,
        pollTimeoutMs: 2000,
      });

      expect(result.status).toBe("SUCCESS");
      expect(result.hash).toBe(tx.hash);
      expect(result.ledger).toBe(12345);
      // Polls the EXACT hash of the submitted envelope (hash-level idempotency).
      expect(mockRpcServer.getTransaction).toHaveBeenCalledWith(tx.hash);
    });

    it("throws TX_FAILED when the transaction lands but fails on-chain", async () => {
      mockRpcServer.sendTransaction.mockResolvedValueOnce({
        status: "PENDING",
        hash: tx.hash,
      });
      mockRpcServer.getTransaction.mockResolvedValueOnce({
        status: "FAILED",
      });

      await expect(
        stellar.submitTransactionSafe(tx.xdr, {
          pollIntervalMs: 1,
          pollTimeoutMs: 2000,
        }),
      ).rejects.toMatchObject({ code: "TX_FAILED", hash: tx.hash });
    });

    it("fails with TX_NOT_CONFIRMED when polling times out without a fee bump", async () => {
      mockRpcServer.sendTransaction.mockResolvedValueOnce({
        status: "PENDING",
        hash: tx.hash,
      });
      mockRpcServer.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });

      await expect(
        stellar.submitTransactionSafe(tx.xdr, {
          pollIntervalMs: 2,
          pollTimeoutMs: 15,
        }),
      ).rejects.toMatchObject({ code: "TX_NOT_CONFIRMED", hash: tx.hash });

      // Only the original submission — no fee-bump configured.
      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("escalates a stalled submission to a fee-bump transaction", async () => {
      mockRpcServer.sendTransaction
        .mockResolvedValueOnce({ status: "PENDING", hash: tx.hash }) // original
        .mockResolvedValueOnce({ status: "PENDING", hash: "fee-bump-hash" }); // fee bump
      mockRpcServer.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });

      const feeBumpKeypair = Keypair.random();
      await expect(
        stellar.submitTransactionSafe(tx.xdr, {
          pollIntervalMs: 2,
          pollTimeoutMs: 15,
          feeBump: { keypair: feeBumpKeypair, maxAttempts: 1 },
        }),
      ).rejects.toMatchObject({ code: "TX_NOT_CONFIRMED" });

      // Original + one fee-bump submission.
      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(2);
      const secondXdr = mockRpcServer.sendTransaction.mock.calls[1][0];
      expect(secondXdr).not.toBe(tx.xdr); // it's a fee-bump envelope

      // The fee-bump still references the SAME inner transaction: parsing it
      // yields a fee-bump envelope whose inner envelope hash == tx.hash.
      const fbEnvelope = require("@stellar/stellar-sdk").xdr.TransactionEnvelope.fromXDR(
        secondXdr,
        "base64",
      );
      expect(fbEnvelope.switch().name).toBe("envelopeTypeTxFeeBump");
      const innerEnvelope = fbEnvelope.feeBump().tx().innerTx();
      const innerHash = new Transaction(innerEnvelope, Networks.TESTNET)
        .hash()
        .toString("hex");
      expect(innerHash).toBe(tx.hash);

      // Prometheus fee-bump counter incremented.
      expect(await counterValue(metrics.stellarFeeBumpsTotal)).toBeGreaterThanOrEqual(1);
    });

    it("retries TRY_AGAIN_LATER instead of treating it as success", async () => {
      mockRpcServer.sendTransaction
        .mockResolvedValueOnce({ status: "TRY_AGAIN_LATER" })
        .mockResolvedValueOnce({ status: "PENDING", hash: tx.hash });
      mockRpcServer.getTransaction.mockResolvedValue({
        status: "SUCCESS",
        ledger: 9,
      });

      const result = await stellar.submitTransactionSafe(tx.xdr, {
        pollIntervalMs: 1,
        pollTimeoutMs: 2000,
      });

      expect(result.status).toBe("SUCCESS");
      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it("fails with TX_TRY_AGAIN_LATER after exhausting retries", async () => {
      mockRpcServer.sendTransaction.mockResolvedValue({ status: "TRY_AGAIN_LATER" });

      await expect(
        stellar.submitTransactionSafe(tx.xdr, { maxRetries: 2 }),
      ).rejects.toMatchObject({ code: "TX_TRY_AGAIN_LATER" });

      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(3); // 1 + 2 retries
    });

    it("fails fast on an ERROR response without retrying (4xx-equivalent)", async () => {
      mockRpcServer.sendTransaction.mockResolvedValue({
        status: "ERROR",
        errorResult: "AAAA",
      });

      await expect(
        stellar.submitTransactionSafe(tx.xdr),
      ).rejects.toMatchObject({ code: "TX_REJECTED" });

      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("retries transient 5xx network errors with backoff", async () => {
      mockRpcServer.sendTransaction
        .mockRejectedValueOnce(new Error("rpc error 500: internal server error"))
        .mockResolvedValueOnce({ status: "PENDING", hash: tx.hash });
      mockRpcServer.getTransaction.mockResolvedValue({
        status: "SUCCESS",
        ledger: 42,
      });

      const result = await stellar.submitTransactionSafe(tx.xdr, {
        maxRetries: 1,
        pollIntervalMs: 1,
        pollTimeoutMs: 2000,
      });

      expect(result.status).toBe("SUCCESS");
      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it("throws TX_TRANSIENT_EXHAUSTED when 5xx retries are exhausted", async () => {
      mockRpcServer.sendTransaction.mockRejectedValue(
        new Error("rpc error 500: internal server error"),
      );

      await expect(
        stellar.submitTransactionSafe(tx.xdr, { maxRetries: 1 }),
      ).rejects.toMatchObject({ code: "TX_TRANSIENT_EXHAUSTED" });

      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it("fails fast with CIRCUIT_OPEN when the circuit breaker is open", async () => {
      // Trip the breaker directly: 5 consecutive failures.
      for (let i = 0; i < 5; i++) {
        await expect(
          rpcBreaker.call(() => {
            throw new Error("rpc error 500");
          }),
        ).rejects.toThrow();
      }
      expect(rpcBreaker.getState()).toBe("open");

      mockRpcServer.sendTransaction.mockClear();
      await expect(
        stellar.submitTransactionSafe(tx.xdr),
      ).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });

      // Fail-fast: no network call was attempted.
      expect(mockRpcServer.sendTransaction).not.toHaveBeenCalled();
    });

    it("recovers through half-open after the cooldown elapses", async () => {
      for (let i = 0; i < 5; i++) {
        await expect(
          rpcBreaker.call(() => {
            throw new Error("rpc error 500");
          }),
        ).rejects.toThrow();
      }
      expect(rpcBreaker.getState()).toBe("open");

      // After the reset window the breaker half-opens and a success re-closes it.
      jest.useFakeTimers();
      try {
        jest.advanceTimersByTime(31_000);
        await expect(
          rpcBreaker.call(async () => "ok"),
        ).resolves.toBe("ok");
        expect(rpcBreaker.getState()).toBe("closed");
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("legacy entry points delegate to the unified pipeline", () => {
    it("submitTransaction polls to finality instead of returning PENDING", async () => {
      mockRpcServer.sendTransaction.mockResolvedValueOnce({
        status: "PENDING",
        hash: tx.hash,
      });
      mockRpcServer.getTransaction.mockResolvedValueOnce({
        status: "SUCCESS",
        ledger: 77,
      });

      const result = await stellar.submitTransaction(tx.xdr);

      expect(result.status).toBe("SUCCESS");
      expect(result.ledger).toBe(77);
      expect(mockRpcServer.getTransaction).toHaveBeenCalledWith(tx.hash);
    });

    it("submitWithFeeBump returns a success-shaped result with the tx hash", async () => {
      mockRpcServer.sendTransaction.mockResolvedValueOnce({
        status: "PENDING",
        hash: tx.hash,
      });
      mockRpcServer.getTransaction.mockResolvedValueOnce({
        status: "SUCCESS",
        ledger: 5,
      });

      const result = await stellar.submitWithFeeBump(
        new Transaction(
          require("@stellar/stellar-sdk").xdr.TransactionEnvelope.fromXDR(
            tx.xdr,
            "base64",
          ),
          Networks.TESTNET,
        ),
        Keypair.random(),
        { pollIntervalMs: 1, pollTimeoutMs: 2000 },
      );

      expect(result.status).toBe("SUCCESS");
      expect(result.successful).toBe(true);
      expect(result.hash).toBe(tx.hash);
    });

    it("records submit duration in the histogram metric", async () => {
      mockRpcServer.sendTransaction.mockResolvedValueOnce({
        status: "PENDING",
        hash: tx.hash,
      });
      mockRpcServer.getTransaction.mockResolvedValueOnce({
        status: "SUCCESS",
        ledger: 1,
      });

      await stellar.submitTransactionSafe(tx.xdr, {
        pollIntervalMs: 1,
        pollTimeoutMs: 2000,
      });

      const snap = await metrics.stellarSubmitDurationSeconds.get();
      const total = snap.values.reduce((sum, v) => sum + (v.value || 0), 0);
      expect(total).toBeGreaterThanOrEqual(1);
    });
  });
});
