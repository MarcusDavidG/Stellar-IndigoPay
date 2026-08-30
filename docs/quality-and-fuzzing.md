# Fuzzing & Performance-Regression Tooling (epic #1101)

This document covers two companion workstreams from
[issue #1101](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/1101):

- **Workstream 4 — API fuzz testing with automatic OpenAPI schema conformance.**
- **Workstream 6 — Load-test regression detection with k6 baseline comparison.**

Both are tooling around the same machine-verified quality goal: a PR can no longer
merge a schema-violating `5xx`-on-garbage-input bug, or a performance regression
that is "under the hard threshold" yet still a big slowdown.

---

## Workstream 4 — API fuzz / OpenAPI conformance

Fuzzes every request-body endpoint with schema-derived **valid** and **invalid**
payloads. The guarantees that matter:

1. Every labelled **valid** case provably satisfies its request schema.
2. Every labelled **invalid** case provably violates it — so a live 4xx→2xx or a
   `5xx` response to one of them is a _real bug_, not fuzzer noise.
3. Live scans assert **no `5xx` for invalid input** (must be 4xx), that responses
   fall within the OpenAPI-declared status codes, and that non-empty 2xx bodies
   conform to their declared response schema.

### Components

| Path                                      | Role                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| `backend/scripts/api-fuzz/values.js`      | Schema-aware valid/invalid value generation                  |
| `backend/scripts/api-fuzz/validator.js`   | Dependency-free JSON-Schema validator (spec keyword subset)  |
| `backend/scripts/api-fuzz/plan.js`        | Derive per-operation fuzz plan from the OpenAPI spec         |
| `backend/scripts/api-fuzz/conformance.js` | Live runner (`fetch`-only) + guaranteed-invalid case builder |
| `scripts/validate-openapi.js`             | Adds `--fuzz [n]` and `--live <baseUrl> [n]` CLI modes       |
| `backend/__tests__/fuzz/api-fuzz.test.js` | Jest suite for generator/validator/plan/runner               |

### Usage

```bash
# Offline self-test — prove generator invariants against the real spec (PR CI).
node scripts/validate-openapi.js --fuzz 100

# Live conformance scan against a running backend (nightly).
node scripts/validate-openapi.js --live https://staging.example.com 1000
```

The modules live under `backend/scripts/api-fuzz/{values,validator,plan,conformance}.js`
(prefixed with a co-located jest suite) rather than the repo-root `scripts/`, because
the backend test image only contains `backend/`. The root `scripts/validate-openapi.js`
is a thin, dependency-free loader so it can run with just `npm ci` at the repo root.

**Why per-case "guaranteed invalid" matters.** A static "this mutation is invalid"
flag is unsound for permissive schemas (e.g. over-length on a string with no
`maxLength`, or extra fields when `additionalProperties` is allowed). Instead, the
runner applies a mutation strategy and keeps it only if the schema validator _also_
rejects the result; when no strategy works it forces an invalid root type. Every
`invalid-…` case sent to a live server is therefore one the schema says must fail.

### CI

- `.github/workflows/ci.yml` — `openapi-lint` job runs `validate-openapi.js --fuzz 100`
  on every PR.
- `.github/workflows/fuzz-nightly.yml` — heavy offline full build nightly + optional
  live conformance scan (via `BASE_URL` secret), artifacts uploaded.

---

## Workstream 6 — k6 load-test regression detection

Adds baseline-aware performance gating on top of the existing hard
`p(95) < 500ms` gate in `scripts/load-test.js`. A PR that moves an endpoint from
`p50 82ms → 150ms` (still under 500ms, an ~83% regression) is now flagged.

Thresholds (all configurable):

| Threshold                        | Default | Effect                                            |
| -------------------------------- | ------- | ------------------------------------------------- |
| `LATENCY_REGRESSION_WARN_PCT`    | 20      | p95 Δ > 20% → ⚠️ warning                          |
| `THROUGHPUT_REGRESSION_WARN_PCT` | 10      | throughput Δ < –10% → ⚠️ warning                  |
| `LATENCY_REGRESSION_BLOCK_PCT`   | 50      | p95 Δ > 50% → ❌ merge-block                      |
| `hardLatencyMs`                  | 500     | p95 > 500ms → ❌ merge-block (existing hard gate) |

### Components

| Path                                                  | Role                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `backend/scripts/load-test-compare.js`                | Comparison/threshold logic, k6-summary parsing, PR-comment rendering |
| `scripts/load-test-compare.js`                        | Thin CLI over the above                                              |
| `scripts/load-test-baseline.json`                     | Committed baseline (updated by the nightly full-load job)            |
| `scripts/load-test.js`                                | k6 script (adds `SCENARIO=pr`, `PR_VUS`, `PR_DURATION`)              |
| `backend/__tests__/scripts/load-test-compare.test.js` | Jest unit tests                                                      |

### Usage

```bash
# PR profile load, capturing a summary export
SCENARIO=pr BASE_URL=https://staging.example.com \
  k6 run --summary-export /tmp/summary.json scripts/load-test.js

# Compare against the committed baseline and print/emit a PR comment
node scripts/load-test-compare.js \
  --baseline scripts/load-test-baseline.json \
  --current /tmp/summary.json --comment
# exit 0 = ok/warn, exit 1 = merge-block
```

### CI

- `.github/workflows/load-test-nightly.yml` — nightly k6 run + baseline compare,
  optional PR comment (`workflow_dispatch` with `pr_number`), fails on blocking
  regressions. Benchmark/compare unit tests run in the backend jest suite.

---

## Local verification

```bash
# Backend jest (tests for both workstreams)
cd backend && npm ci && npm test

# Offline fuzz self-test against the real spec
cd .. && node scripts/validate-openapi.js --fuzz 100
```
