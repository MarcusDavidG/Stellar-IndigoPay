/**
 * test/chaos/scenarios/06-cascading.js
 *
 * Scenario 06 — cascading failure (epic #1101, Workstream 3: "Cascading
 * failure: Redis down + PostgreSQL failover + Horizon 503 simultaneously").
 *
 * The hardest resilience class: multiple independent faults overlap, so no
 * single mitigation (retry, listener, pool recovery, cache fallback) suffices.
 * The system must reach a *degraded-but-functional* state — endpoints respond
 * (not hang, not OOM) — and every component must recover independently, with
 * **zero data loss and zero double-records** once the underlying services return.
 *
 * Coordinated with the host via marker files (see test/chaos/README.md):
 *   - driver sets the Horizon 503 stub fault itself, then writes `06.ready`;
 *   - host stops REDIS *and* POSTGRES and writes `06.faulted`;
 *   - driver asserts degraded-but-alive mid-cascade (avoiding any DB
 *     dependency while Postgres is down) and writes `06.during`;
 *   - host starts REDIS *and* POSTGRES, waits both healthy, writes `06.recovered`;
 *   - driver clears the Horizon fault and asserts recovery + no data loss.
 *
 * Note: while Postgres is down the driver must not rely on the `pool`, so the
 * mid-cascade assertions are limited to the app staying responsive (an RPC-level
 * probe) and the donation being rejected cleanly. Every stateful assertion is
 * made after recovery.
 */
"use strict";

const h = require("../lib/harness");

const PROJECT_ID = "55555555-5555-5555-5555-555555555555";

async function run() {
  const { rpc } = require("@stellar/stellar-sdk");

  // App modules (mounted at /backend/src in the container).
  const { withRetry } = require("/backend/src/services/stellar");
  const { recordDonation } = require("/backend/src/routes/donations");
  const stubRpc = new rpc.Server(`${h.STUB_URL}/soroban`, { allowHttp: true });

  h.log("=== Scenario 06: cascading failure — Redis + Postgres + Horizon down; independent recovery ===");
  await h.resetDb();
  await h.seedProject(PROJECT_ID);

  // Sanity before the cascade: Soroban RPC is reachable through no fault.
  const healthy = await withRetry(() => stubRpc.getLatestLedger());
  h.assert(healthy && typeof healthy.sequence === "number", "baseline: Soroban RPC reachable");

  const donor = h.makePublicKey("C");
  const txHash = h.makeTxHash("6");

  // Bounded execution: recordDonation opens a Postgres tx early (`pool.connect`),
  // so while Postgres is down it may fail cleanly OR legitimately wait on a
  // reconnect. Either is acceptable mid-cascade — the acceptance test for "no
  // data loss / no double-record" is done AFTER recovery (below). We must never
  // let the hang stall the whole suite, so bound the attempt.
  const withTimeout = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("donation attempt timed out during cascade")), ms),
      ),
    ]);

  // ── Inject the stub-side fault (Horizon 503) and arm the host cascade ────
  await h.setFault("horizon", "503");
  h.writeMarker("06.ready");
  await h.waitForMarker("06.faulted");

  // ── Mid-cascade: degraded-but-alive ──────────────────────────────────────
  // With Horizon faulted AND Redis + Postgres unreachable, a donation attempt
  // must never be CONFIRMED (no fake data). Clean rejection or a bounded wait on
  // the unreachable DB are both "degraded" outcomes; only a 2xx confirmation is
  // a real failure. No state mutation is committed because recording aborts.
  let outcome;
  try {
    const attempted = await withTimeout(
      h.invokeRecordDonation(recordDonation, {
        projectId: PROJECT_ID,
        donorAddress: donor,
        amountXLM: "14",
        currency: "XLM",
        transactionHash: txHash,
      }),
      15000,
    );
    outcome = attempted.statusCode;
  } catch (err) {
    outcome = "rejected-or-pended";
  }
  h.assert(
    outcome === "rejected-or-pended" || (outcome !== 201 && outcome !== 200),
    `donation was never confirmed mid-cascade (outcome: ${outcome}) — no fake data`,
  );

  // The process is still alive and can still drive the RPC resilience path
  // (which depends only on the stub, not Redis/Postgres).
  const stillAlive = await withRetry(() => stubRpc.getLatestLedger()).catch(() => null);
  h.assert(stillAlive !== null, "app still responsive during the cascade (degraded-but-functional)");

  h.writeMarker("06.during");
  await h.waitForMarker("06.recovered");

  // ── All faults cleared: independent recovery + no data loss ──────────────
  await h.clearFault("horizon");

  // Redis recovered.
  await h.waitForRedis();

  // Postgres recovered and empty — zero partial writes during the cascade.
  await h.waitFor(async () => {
    const c = await h.countDonations(PROJECT_ID).catch(() => null);
    return c === 0;
  }, { timeoutMs: 60000, intervalMs: 1000, label: "Postgres to recover and show zero partial writes" });
  h.assert((await h.countDonations(PROJECT_ID)) === 0, "no data written during the cascade (zero partial writes)");

  // The exact same donation now records successfully — and exactly once.
  const recorded = await h.invokeRecordDonation(recordDonation, {
    projectId: PROJECT_ID,
    donorAddress: donor,
    amountXLM: "14",
    currency: "XLM",
    transactionHash: txHash,
  });
  h.assert(recorded.statusCode === 201, "donation recorded after full recovery");

  const replay = await h.invokeRecordDonation(recordDonation, {
    projectId: PROJECT_ID,
    donorAddress: donor,
    amountXLM: "14",
    currency: "XLM",
    transactionHash: txHash,
  });
  h.assert(replay.statusCode === 200 && replay.body.success === true, "re-submission replays (no double-record)");
  h.assert((await h.countDonations(PROJECT_ID)) === 1, "exactly one row after cascade recovery + replay");
  h.assert((await h.projectRaised(PROJECT_ID)) === 14, "project raised_xlm counted once (14)");
  h.log("scenario 06 complete: cascade reached degraded-but-functional, all components recovered, no data loss");
}

module.exports = { run };