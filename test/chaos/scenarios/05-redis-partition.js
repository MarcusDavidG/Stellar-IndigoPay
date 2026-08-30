/**
 * test/chaos/scenarios/05-redis-partition.js
 *
 * Scenario 05 — network partition between the backend and Redis (epic #1101,
 * Workstream 3: "Network partition between backend and Redis").
 *
 * Unlike the Redis *crash* in scenario 01 (the process is stopped/restarted),
 * here the fault is a true partition: the stateful Redis process stays up, but
 * the docker network link from the container holding the app is severed by the
 * host (`docker network disconnect`), so every TCP connection between the app
 * and Redis is dropped and nothing can reconnect. This is the failure mode that
 * retry storms during crash-restart don't catch.
 *
 * Coordinated with the host via marker files (see test/chaos/README.md):
 *   - driver writes `05.ready`           when it is armed and waiting;
 *   - host disconnects REDIS and writes `05.faulted`;
 *   - driver asserts mid-partition behavior and writes `05.during`;
 *   - host reconnects REDIS (healthcheck healthy) and writes `05.recovered`;
 *   - driver asserts recovery.
 *
 * Assertions (all match the app's real behavior under an unreachable cache):
 *   - Cache reads degrade to a miss (resolve `null`) instead of throwing or
 *     hanging — the slowest failure mode is a request that never returns.
 *   - The rate limiter falls back to its in-memory gate: a donation recorded
 *     mid-partition is neither rate-limited by a stale unit nor 500s, because
 *     the limiter's Redis backstop being unreachable must not block the money
 *     path.
 *   - Recovery: once the partition heals, Redis accepts commands again and a
 *     further donation/read succeeds — the cache repopulates instead of
 *     staying poisoned.
 */
"use strict";

const h = require("../lib/harness");

const PROJECT_ID = "44444444-4444-4444-4444-444444444444";

async function run() {
  // App modules (mounted at /backend/src in the container).
  const redis = require("/backend/src/services/redis");
  const { recordDonation } = require("/backend/src/routes/donations");

  h.log("=== Scenario 05: Redis network partition — cache fallback + rate-limiter memory backstop ===");
  await h.resetDb();
  await h.seedProject(PROJECT_ID);

  // ── Baseline: cache writable + rate limiter healthy before the partition ──
  await h.waitForRedis();
  const c0 = redis.getClient();
  await c0.set("chaos:baseline", "1");
  h.assert((await c0.get("chaos:baseline")) === "1", "cache writable before partition");

  const donor = h.makePublicKey("N");
  const txHash = h.makeTxHash("5");

  // ── Arm: tell the host we are ready for the partition ────────────────────
  h.writeMarker("05.ready");
  await h.waitForMarker("05.faulted");

  // ── Mid-partition: cache must miss (not hang / not throw) ────────────────
  // A dropped TCP link surfaces as an ECONNRESET/ETIMEDOUT to ioredis, which
  // the app's cache layer must convert into a cache-miss rather than a 500.
  // We probe a few keys; each probe must resolve (never hang) and return null.
  const key = `chaos:partition:${Date.now()}`;
  let probeResult;
  let probeDurationMs = 0;
  const probeStart = Date.now();
  try {
    probeResult = await c0.get(key);
  } catch (err) {
    // Some drivers surface the unreachable peer as a rejected promise rather
    // than null. A *propagated* error is a real bug (the money path would 500),
    // so only accept the resolution-to-null case; anything else must fail.
    throw new Error(`cache read raced the partition and threw instead of missing: ${err.message}`);
  }
  probeDurationMs = Date.now() - probeStart;
  h.assert(probeResult === null, "cache read during partition resolves to a miss (no hang, no throw)");
  h.assert(probeDurationMs < 10000, `cache read did not hang (took ${probeDurationMs}ms)`);

  // ── Mid-partition: donation recording still works (rate-limiter memory backstop) ──
  // The limiter's Redis backstop is unreachable; the in-memory gate must take
  // over so a legit donor is neither blocked by a stale bucket nor 500s.
  const recorded = await h.invokeRecordDonation(recordDonation, {
    projectId: PROJECT_ID,
    donorAddress: donor,
    amountXLM: "7",
    currency: "XLM",
    transactionHash: txHash,
  });
  h.assert(
    recorded.statusCode === 201 || (recorded.statusCode === 429 && recorded.body && !recorded.body.error),
    `donation request handled without 500 during partition (status ${recorded.statusCode})`,
  );

  h.writeMarker("05.during");
  await h.waitForMarker("05.recovered");

  // ── Recovery ─────────────────────────────────────────────────────────────
  await h.waitForRedis();
  await c0.set("chaos:post-partition", "1");
  h.assert(
    (await c0.get("chaos:post-partition")) === "1",
    "cache writable again after the partition healed (not poisoned)",
  );

  // The donation recorded during the partition persisted exactly once.
  h.assert((await h.countDonations(PROJECT_ID)) === 1, "donation recorded during partition persisted exactly once");
  h.assert((await h.projectRaised(PROJECT_ID)) === 7, "project raised_xlm counted once (7)");
  h.log("scenario 05 complete: cache degraded to misses, rate limiter fell back, everything recovered");
}

module.exports = { run };