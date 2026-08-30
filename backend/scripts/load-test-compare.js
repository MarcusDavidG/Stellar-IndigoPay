"use strict";

/**
 * load-test-compare.js
 *
 * Load-test regression detection (epic #1101, Workstream 6).
 *
 * Pure, dependency-free module that:
 *   1. Parses k6 `--summary-export` JSON into per-endpoint latency + throughput
 *      numbers.
 *   2. Compares a PR/current run against a committed baseline
 *      (scripts/load-test-baseline.json).
 *   3. Flags endpoints whose p95 latency regressed by more than
 *      LATENCY_REGRESSION_WARN_PCT (default 20%), or whose throughput dropped by
 *      more than THROUGHPUT_REGRESSION_WARN_PCT (default 10%).
 *   4. Blocks merge when p95 regresses by more than
 *      LATENCY_REGRESSION_BLOCK_PCT (default 50%) or exceeds the hard 500ms
 *      threshold (the existing scripts/load-test.js hard gate).
 *   5. Formats a human-readable GitHub PR comment (table) from the results.
 *
 * Keeping this in backend/ (rather than the repo-root scripts/) means it is
 * covered by the backend jest suite, which runs in the isolated backend test
 * container during CI.
 */

const DEFAULT_THRESHOLDS = {
  latencyWarnPct: 20,
  latencyBlockPct: 50,
  hardLatencyMs: 500, // mirrors the hard p(95)<500 gate in load-test.js
  throughputWarnPct: 10,
};

const SUPPORTED_METRICS = ["p95", "p50", "p99", "throughput"];

/**
 * Resolve effective thresholds from a partial overrides object.
 * @param {object} overrides
 * @returns {object} merged thresholds
 */
function thresholds(overrides = {}) {
  return { ...DEFAULT_THRESHOLDS, ...overrides };
}

/**
 * Extract a numeric percentile from a k6 Trend `values` object. k6 summary
 * exports emit percentile keys in the `p(95)` form (not `p95`); accept both so
 * hand-built fixtures and any future format keep working.
 */
function percentile(values, number) {
  if (!values || typeof values !== "object") return null;
  const v = values[`p(${number})`] ?? values[`p${number}`];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/**
 * Parse a k6 `--summary-export` JSON object into a map of
 * `endpoint -> { p50, p95, p99, throughput }`.
 *
 * k6 export layout:
 *   {
 *     "metrics": {
 *       "http_req_duration": { "values": { "p50":…, "p95":…, "p99":… } … },
 *       "http_req_duration{endpoint:POST /api/donations}": { "values": …, "tags": {"endpoint": "POST /api/donations"} },
 *       "http_reqs{endpoint:…}": { "values": { "count": 123 }, "tags": {"endpoint": …} },
 *       ...
 *     }
 *   }
 *
 * When no endpoint tag is present we fall back to the global metric keyed by
 * "GLOBAL". Un-tagged requests (e.g. redirects) are ignored.
 *
 * @param {object} raw parsed k6 JSON
 * @returns {Object<string, {p50:number|null,p95:number|null,p99:number|null,throughput:number|null}>}
 */
function parseK6Summary(raw) {
  const result = {};
  if (!raw || !raw.metrics || typeof raw.metrics !== "object") return result;

  for (const [key, metric] of Object.entries(raw.metrics)) {
    if (!metric || typeof metric !== "object") continue;
    const tags = metric.tags || {};
    const endpoint = tags.endpoint || globalKeyEndpoint(key);
    if (!endpoint) continue;

    const entry = result[endpoint] || {
      p50: null,
      p95: null,
      p99: null,
      throughput: null,
    };

    if (key.startsWith("http_req_duration")) {
      const values = metric.values || {};
      entry.p50 = percentile(values, 50);
      entry.p95 = percentile(values, 95);
      entry.p99 = percentile(values, 99);
    } else if (key.startsWith("http_reqs")) {
      // k6 exports throughput for a metric in `values.rate` (requests/second).
      // Falling back to the raw counter keeps tolerant fixtures working.
      const values = metric.values || {};
      const rate = values.rate;
      entry.throughput =
        typeof rate === "number" && Number.isFinite(rate)
          ? rate
          : typeof values.count === "number"
            ? values.count
            : null;
    }

    result[endpoint] = entry;
  }

  return result;
}

function globalKeyEndpoint(key) {
  // If the key itself embeds `{endpoint:…}` but there is no tags object.
  const m = /endpoint:([^}]+)/.exec(key);
  return m ? m[1] : null;
}

/**
 * Load a baseline file (committed scripts/load-test-baseline.json) into a
 * `endpoint -> { p95, throughput }` map, normalising between metric names.
 * @param {object} baseline parsed baseline JSON
 * @returns {Object<string, {p95:number|null, throughput:number|null}>}
 */
function parseBaseline(baseline) {
  const out = {};
  if (!baseline || typeof baseline !== "object") return out;
  const perEndpoint = baseline.endpoints || baseline;
  for (const [endpoint, v] of Object.entries(perEndpoint)) {
    if (!v || typeof v !== "object") continue;
    out[endpoint] = {
      p95: normalizeMs(v.p95 ?? v.latencyP95 ?? null),
      throughput: normalizeNum(v.throughput ?? v.requestsPerSecond ?? null),
    };
  }
  return out;
}

function normalizeMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
function normalizeNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/**
 * Compute a single endpoint regression row.
 * @returns {object} { endpoint, p95, baselineP95, deltaPct, throughput, baselineThroughput, throughputDeltaPct, status }
 */
function compareEndpoint(endpoint, current, baselineEndpoint, th) {
  const baseP95 = baselineEndpoint ? baselineEndpoint.p95 : null;
  const curP95 = current.p95;
  const baseThroughput = baselineEndpoint ? baselineEndpoint.throughput : null;
  const curThroughput = current.throughput;

  let deltaPct = null;
  let throughputDeltaPct = null;
  if (curP95 != null && baseP95 != null && baseP95 > 0) {
    deltaPct = ((curP95 - baseP95) / baseP95) * 100;
  }
  if (curThroughput != null && baseThroughput != null && baseThroughput > 0) {
    throughputDeltaPct =
      ((curThroughput - baseThroughput) / baseThroughput) * 100;
  }

  // Merge-blocking conditions. The hard gate mirrors scripts/load-test.js's
  // `p(95)<500` (strictly less than), so exactly 500ms must block → use >=.
  const hardThresholdBreach = curP95 != null && curP95 >= th.hardLatencyMs;
  const latencyBlock =
    curP95 != null &&
    baseP95 != null &&
    baseP95 > 0 &&
    deltaPct > th.latencyBlockPct;
  const latencyWarn =
    curP95 != null &&
    baseP95 != null &&
    baseP95 > 0 &&
    deltaPct > th.latencyWarnPct &&
    !latencyBlock;
  const throughputWarn =
    curThroughput != null &&
    baseThroughput != null &&
    throughputDeltaPct < -th.throughputWarnPct;

  let status = "ok";
  if (hardThresholdBreach || latencyBlock) status = "block";
  else if (latencyWarn) status = "warn-latency";
  else if (throughputWarn) status = "warn-throughput";

  return {
    endpoint,
    p95: curP95,
    baselineP95: baseP95,
    deltaPct: deltaPct == null ? null : round1(deltaPct),
    throughput: curThroughput,
    baselineThroughput: baseThroughput,
    throughputDeltaPct:
      throughputDeltaPct == null ? null : round1(throughputDeltaPct),
    hardThresholdBreach,
    status,
  };
}

/**
 * Compare a full current run against a baseline.
 * @param {object} opts { baseline, current, thresholds }
 * @returns {{ rows: object[], blocked: boolean, warned: boolean, summary: object }}
 */
function compareBaseline({ baseline, current, thresholds: thOverrides }) {
  const th = thresholds(thOverrides);
  const baselineMap = parseBaseline(baseline);
  const currentMap =
    current && typeof current.endpoints === "object"
      ? parseBaseline(current) // tolerate baseline-shaped input
      : current || {};

  const endpoints = new Set([
    ...Object.keys(baselineMap),
    ...Object.keys(currentMap),
  ]);
  const rows = [];
  for (const endpoint of Array.from(endpoints).sort()) {
    const cur = currentMap[endpoint] || {};
    const base = baselineMap[endpoint];
    // Only compare endpoints present in the current run.
    if (cur.p95 == null && cur.throughput == null) continue;
    rows.push(compareEndpoint(endpoint, cur, base, th));
  }

  const blocked = rows.some((r) => r.status === "block");
  const warned = rows.some((r) => r.status.startsWith("warn"));

  return {
    rows,
    blocked,
    warned,
    summary: {
      thresholdWarnPct: th.latencyWarnPct,
      thresholdBlockPct: th.latencyBlockPct,
    },
  };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

const STATUS_ICON = {
  block: "❌",
  "warn-latency": "⚠️",
  "warn-throughput": "⚠️",
  ok: "✅",
};

/**
 * Render a GitHub PR comment (markdown table) from compareBaseline output.
 * @param {{rows:object[],blocked:boolean,warned:boolean,summary:object}} result
 * @returns {string}
 */
function formatPrComment(result) {
  if (!result || !Array.isArray(result.rows)) {
    return "### Load-test regression check\n\nNo results to report.";
  }
  const lines = [];
  lines.push("### Load-test regression check");
  lines.push("");
  lines.push(
    "Comparing this PR to the committed baseline (`scripts/load-test-baseline.json`).",
  );
  lines.push("");
  lines.push("| Endpoint | Baseline p95 | PR p95 | Δ p95 | Δ ± | Status |");
  lines.push("| --- | ---: | ---: | ---: | ---: | :---: |");
  for (const r of result.rows) {
    const base = r.baselineP95 == null ? "—" : `${ms(r.baselineP95)}`;
    const cur = r.p95 == null ? "—" : `${ms(r.p95)}`;
    const delta =
      r.deltaPct == null ? "—" : `${r.deltaPct > 0 ? "+" : ""}${r.deltaPct}%`;
    const icon = STATUS_ICON[r.status] || "☑️";
    let statusText = r.status;
    if (r.hardThresholdBreach)
      statusText = `block (p95 > ${result.summary?.hardLatencyMs || 500}ms hard gate)`;
    lines.push(
      `| \`${r.endpoint}\` | ${base} | ${cur} | ${delta} | — | ${icon} ${statusText} |`,
    );
  }
  lines.push("");

  if (result.warned) {
    lines.push(
      "⚠️ **Warning:** at least one endpoint regressed beyond the warn threshold. Review before merging.",
    );
  }
  if (result.blocked) {
    lines.push(
      "❌ **Merge blocked:** at least one endpoint regressed beyond the block threshold, or breached the hard 500ms p95 gate.",
    );
  } else {
    lines.push("✅ No blocking performance regressions detected.");
  }
  lines.push("");
  lines.push(
    `_Thresholds — warn: p95 Δ > ${result.summary?.thresholdWarnPct ?? 20}% or throughput Δ < -${result.summary?.throughputWarnPct ?? 10}%. Block: p95 Δ > ${result.summary?.thresholdBlockPct ?? 50}% or p95 > 500ms._`,
  );
  return lines.join("\n");
}

function ms(v) {
  return `${v.toFixed(1)}ms`;
}

/**
 * True when the combined result should fail a merge check.
 */
function shouldBlock(result) {
  return !!(result && result.blocked);
}

module.exports = {
  DEFAULT_THRESHOLDS,
  thresholds,
  parseK6Summary,
  parseBaseline,
  compareEndpoint,
  compareBaseline,
  formatPrComment,
  shouldBlock,
  SUPPORTED_METRICS,
};
