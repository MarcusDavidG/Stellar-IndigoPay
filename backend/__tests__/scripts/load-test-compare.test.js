"use strict";

/**
 * Unit tests for backend/scripts/load-test-compare.js
 *
 * Covers (Workstream 6) baseline comparison, threshold evaluation, k6 summary
 * parsing, and PR-comment rendering in an offline, deterministic way — no k6
 * binary or running backend required.
 */

const {
  thresholds,
  parseK6Summary,
  parseBaseline,
  compareBaseline,
  formatPrComment,
  shouldBlock,
  DEFAULT_THRESHOLDS,
} = require("../../scripts/load-test-compare");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCurrent(endpoints) {
  const out = {};
  for (const [ep, v] of Object.entries(endpoints)) {
    out[ep] = {
      p50: v.p50 ?? null,
      p95: v.p95,
      p99: v.p99 ?? null,
      throughput: v.throughput ?? null,
    };
  }
  return out;
}

function makeBaseline(endpoints) {
  return { endpoints };
}

describe("thresholds", () => {
  test("defaults match the hard gate documented in load-test.js", () => {
    const t = thresholds();
    expect(t.latencyWarnPct).toBe(20);
    expect(t.latencyBlockPct).toBe(50);
    expect(t.hardLatencyMs).toBe(500);
    expect(t.throughputWarnPct).toBe(10);
  });

  test("merges partial overrides", () => {
    const t = thresholds({ latencyWarnPct: 30 });
    expect(t.latencyWarnPct).toBe(30);
    expect(t.latencyBlockPct).toBe(DEFAULT_THRESHOLDS.latencyBlockPct);
  });

  test("keeps defaults when only unknown keys are provided", () => {
    const t = thresholds({ nope: 1 });
    expect(t.nope).toBe(1); // merged through
    expect(t.latencyWarnPct).toBe(DEFAULT_THRESHOLDS.latencyWarnPct);
  });
});

describe("parseK6Summary", () => {
  test("extracts per-endpoint p50/p95/p99 from k6 summary-export JSON", () => {
    const raw = {
      metrics: {
        http_req_duration: { values: { "p(50)": 82, "p(95)": 210 } },
        "http_req_duration{endpoint:POST /api/donations}": {
          values: { "p(50)": 80, "p(95)": 220, "p(99)": 400 },
          tags: { endpoint: "POST /api/donations" },
        },
        "http_req_duration{endpoint:GET /api/leaderboard}": {
          values: { "p(50)": 12, "p(95)": 30, "p(99)": 55 },
          tags: { endpoint: "GET /api/leaderboard" },
        },
      },
    };
    const out = parseK6Summary(raw);
    expect(out["POST /api/donations"]).toEqual({
      p50: 80,
      p95: 220,
      p99: 400,
      throughput: null,
    });
    expect(out["GET /api/leaderboard"]).toEqual({
      p50: 12,
      p95: 30,
      p99: 55,
      throughput: null,
    });
    expect(out["http_req_duration"]).toBeUndefined(); // global metric has no endpoint tag
  });

  test("reads throughput from http_reqs.values.rate (k6 requests-per-second)", () => {
    const raw = {
      metrics: {
        "http_reqs{endpoint:POST /api/donations}": {
          values: { rate: 300, count: 600 },
          tags: { endpoint: "POST /api/donations" },
        },
        "http_req_duration{endpoint:POST /api/donations}": {
          values: { "p(95)": 100 },
          tags: { endpoint: "POST /api/donations" },
        },
      },
    };
    const out = parseK6Summary(raw);
    expect(out["POST /api/donations"].p95).toBe(100);
    // rate is already in requests/second
    expect(out["POST /api/donations"].throughput).toBe(300);
  });

  test("falls back to the counter when a rate is absent", () => {
    const raw = {
      metrics: {
        "http_reqs{endpoint:GET /api/leaderboard}": {
          values: { count: 42 },
          tags: { endpoint: "GET /api/leaderboard" },
        },
      },
    };
    const out = parseK6Summary(raw);
    expect(out["GET /api/leaderboard"].throughput).toBe(42);
  });

  test("does not explode on missing metrics or malformed input", () => {
    expect(parseK6Summary(null)).toEqual({});
    expect(parseK6Summary({})).toEqual({});
    expect(parseK6Summary({ metrics: { x: 1 } })).toEqual({});
  });

  test("gracefully falls back to an endpoint embedded in the metric key when tags are absent", () => {
    const raw = {
      metrics: {
        "http_req_duration{endpoint:GET /api/stats/global}": {
          values: { "p(95)": 88 },
        },
      },
    };
    const out = parseK6Summary(raw);
    expect(out["GET /api/stats/global"].p95).toBe(88);
  });
});

describe("parseBaseline", () => {
  test("reads p95 and throughput aliases from a baseline file", () => {
    const b = parseBaseline({
      endpoints: {
        "POST /api/donations": { p95: 200, throughput: 5.0 },
        "GET /api/leaderboard": { latencyP95: 30, requestsPerSecond: 400 },
      },
    });
    expect(b["POST /api/donations"]).toEqual({ p95: 200, throughput: 5 });
    expect(b["GET /api/leaderboard"]).toEqual({ p95: 30, throughput: 400 });
  });

  test("handles flat baseline shape (no endpoints key)", () => {
    const b = parseBaseline({ "GET /api/leaderboard": { p95: 28 } });
    expect(b["GET /api/leaderboard"].p95).toBe(28);
  });
});

describe("compareBaseline", () => {
  test("flags no regression when PR is faster than baseline", () => {
    const baseline = makeBaseline({
      "GET /api/leaderboard": { p95: 30, throughput: 100 },
    });
    const current = makeCurrent({
      "GET /api/leaderboard": { p95: 25, throughput: 120 },
    });
    const res = compareBaseline({ baseline, current });
    expect(res.blocked).toBe(false);
    expect(res.warned).toBe(false);
    expect(res.rows[0].status).toBe("ok");
  });

  test("warns (not blocks) on a 30% p95 regression", () => {
    const baseline = makeBaseline({
      "GET /api/leaderboard": { p95: 100, throughput: 100 },
    });
    const current = makeCurrent({
      "GET /api/leaderboard": { p95: 130, throughput: 100 },
    });
    const res = compareBaseline({ baseline, current });
    expect(res.warned).toBe(true);
    expect(res.blocked).toBe(false);
    expect(res.rows[0].status).toBe("warn-latency");
    expect(res.rows[0].deltaPct).toBe(30);
  });

  test("blocks on a 60% p95 regression", () => {
    const baseline = makeBaseline({
      "GET /api/leaderboard": { p95: 100, throughput: 100 },
    });
    const current = makeCurrent({
      "GET /api/leaderboard": { p95: 160, throughput: 100 },
    });
    const res = compareBaseline({ baseline, current });
    expect(res.blocked).toBe(true);
    expect(res.rows[0].status).toBe("block");
    expect(res.rows[0].deltaPct).toBe(60.0);
  });

  test("blocks when p95 exceeds the 500ms hard gate even with no baseline", () => {
    const baseline = makeBaseline({});
    const current = makeCurrent({ "POST /api/donations": { p95: 620 } });
    const res = compareBaseline({ baseline, current });
    expect(res.blocked).toBe(true);
    expect(res.rows[0].hardThresholdBreach).toBe(true);
  });

  test("blocks when p95 is exactly 500ms (hard gate is p(95)<500)", () => {
    const baseline = makeBaseline({});
    const current = makeCurrent({ "POST /api/donations": { p95: 500 } });
    const res = compareBaseline({ baseline, current });
    expect(res.blocked).toBe(true);
    expect(res.rows[0].hardThresholdBreach).toBe(true);
  });

  test("warns when throughput drops more than 10%", () => {
    const baseline = makeBaseline({
      "GET /api/leaderboard": { p95: 30, throughput: 100 },
    });
    const current = makeCurrent({
      "GET /api/leaderboard": { p95: 30, throughput: 80 },
    });
    const res = compareBaseline({ baseline, current });
    expect(res.warned).toBe(true);
    expect(res.blocked).toBe(false);
    expect(res.rows[0].status).toBe("warn-throughput");
    expect(res.rows[0].throughputDeltaPct).toBe(-20);
  });

  test("honours custom thresholds", () => {
    const baseline = makeBaseline({ "GET /api/leaderboard": { p95: 100 } });
    const current = makeCurrent({ "GET /api/leaderboard": { p95: 115 } });
    const res = compareBaseline({
      baseline,
      current,
      thresholds: { latencyWarnPct: 10, latencyBlockPct: 20 },
    });
    expect(res.warned).toBe(true);
    expect(res.blocked).toBe(false);

    const res2 = compareBaseline({
      baseline,
      current,
      thresholds: { latencyWarnPct: 30 },
    });
    expect(res2.warned).toBe(false);
  });

  test("ignores endpoints present only in the baseline (no current data)", () => {
    const baseline = makeBaseline({
      "GET /a": { p95: 30 },
      "GET /b": { p95: 30 },
    });
    const current = makeCurrent({ "GET /a": { p95: 25 } });
    const res = compareBaseline({ baseline, current });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].endpoint).toBe("GET /a");
  });
});

describe("formatPrComment", () => {
  const result = compareBaseline({
    baseline: makeBaseline({
      "POST /api/donations": { p95: 200, throughput: 300 },
      "GET /api/leaderboard": { p95: 30, throughput: 400 },
    }),
    current: {
      "POST /api/donations": { p95: 150, throughput: 320 },
      "GET /api/leaderboard": { p95: 42, throughput: 300 },
    },
  });

  test("includes a markdown table with endpoint, baseline, current, delta and status", () => {
    const md = formatPrComment(result);
    expect(md).toContain("### Load-test regression check");
    expect(md).toContain("| Endpoint | Baseline p95 | PR p95 |");
    expect(md).toContain("POST /api/donations");
    expect(md).toContain("warn-latency");
    expect(md).toContain("40%"); // (42-30)/30
  });

  test("says ready when nothing is blocked/warned", () => {
    const okRes = compareBaseline({
      baseline: makeBaseline({
        "GET /api/leaderboard": { p95: 40, throughput: 300 },
      }),
      current: makeCurrent({
        "GET /api/leaderboard": { p95: 35, throughput: 320 },
      }),
    });
    const md = formatPrComment(okRes);
    expect(md).toContain("✅ No blocking performance regressions detected.");
  });

  test("announces merge-block when a blocking row exists", () => {
    const blockedRes = compareBaseline({
      baseline: makeBaseline({
        "GET /api/leaderboard": { p95: 100, throughput: 100 },
      }),
      current: makeCurrent({
        "GET /api/leaderboard": { p95: 170, throughput: 100 },
      }),
    });
    const md = formatPrComment(blockedRes);
    expect(md).toContain("❌ **Merge blocked:**");
    expect(shouldBlock(blockedRes)).toBe(true);
  });

  test("handles empty rows", () => {
    const md = formatPrComment({ rows: [], blocked: false, warned: false });
    expect(md).toContain("### Load-test regression check");
  });

  test("handles null/undefined result", () => {
    expect(formatPrComment(null)).toContain("No results to report.");
    expect(formatPrComment(undefined)).toContain("No results to report.");
  });
});
