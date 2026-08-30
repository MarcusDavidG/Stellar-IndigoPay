# Testing & Quality Tooling (epic #1101)

[Issue #1101](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/1101)
is a testing/quality hardening epic of **seven coupled workstreams** that turn
quality into a continuous, machine-verified gate across every layer. This
document is the operating manual for all seven:

1. **Workstream 1 — Kani formal verification** (contract-level state invariants).
2. **Workstream 2 — Cross-contract invariant fuzzing** (deploy all 4 contracts,
   global invariants after every step).
3. **Workstream 3 — Chaos engineering** (fault injection for the donation pipeline).
4. **Workstream 4 — API fuzz testing** with automatic OpenAPI schema conformance.
5. **Workstream 5 — Visual regression testing** (Playwright screenshot comparison).
6. **Workstream 6 — Load-test regression detection** (k6 baseline comparison).
7. **Workstream 7 — End-to-end synthetic transaction monitoring**.

Every workstream is CI-enabled — either on every PR (fast paths) or nightly (full
paths) — so a PR can no longer merge a schema-violating `5xx`-on-garbage-input bug,
a cross-contract accounting drift, a proven-arithmetic violation, a broken
layout/theme, a performance regression "under the hard threshold" yet still a big
slowdown, or a broken browser donation flow.

Sections for the four runnable-here / documented workstreams (WS4, WS6, WS2)
follow, then the remaining three (WS1, WS3, WS5, WS7) each link to their
reference implementation and CI job.

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

## Workstream 2 — Cross-chain attestation fuzz property tests

The Soroban side of the epic already ships a deep integration fuzz harness
(`contracts/indigopay-contract/tests/cross_contract_fuzz.rs`, run nightly as the
"Cross-Contract Fuzz (WS5)" CI job) that deploys IndigoPay together with the
oracle, native/USDC assets, and the real **attestation contract**, driving
register/donate/attest/settle sequences.

WS2's contribution here fills the attestation contract's previously **empty**
`fuzz_tests.rs` placeholder with property tests for the _bridge_ half of the
ledger — a donor on a non-Stellar source chain recorded as an attestation:

1. **Aggregate consistency** — per-donor and per-chain roll-up counters exactly
   mirror the sum of individual attestations across mixed single/batch records.
2. **Replay guard** — recording the same `(source_chain, source_tx_hash)` twice
   always panics and never mutates the ledger twice.
3. **Lifecycle accounting** — verify/revoke produce the same final status counts
   (pending/verified/revoked still sum to total) whether executed as
   verify-then-revoke or directly from pending.

Run locally:

```bash
cd contracts && cargo test --features testutils -p attestation-contract -- fuzz
```

---

## Workstream 1 — Kani formal verification

The formal-verification leg proves — not just tests — the critical accounting,
payout, pricing, and lifecycle invariants over **all** bounded inputs. The
Soroban contracts are host-bound, so each on-chain property is encoded as an
equivalent **pure-function mirror** of the exact checked arithmetic the contract
performs, and proven with Kani (CBMC-based, `cargo kani`).

Proven in `contracts/indigopay-contract/verification/kani/src/lib.rs`:

1. `invariant_global_total` — `GlobalTotalRaised` accumulation never overflows
   and the running total always equals the reference sum.
2. `verify_payout_is_bounded_by_amount` — a proportional payout never exceeds
   the escrow job amount.
3. `verify_payout_sum_never_exceeds_amount` — Σ(released milestones) ≤ amount
   whenever the proportions sum to ≤ 100.
4. `verify_reverse_donation_accounting_restores_exactly` — donate(a)→reverse(a)
   restores every counter exactly.
5. `verify_twap_is_bounded_by_observed_prices` — the oracle TWAP always sits
   within `[min, max]` observed prices.
6. `verify_badge_threshold_disjointness` + `verify_badge_tier_is_monotonic` —
   badge tiers are disjoint and monotonic in cumulative contribution.
7. `verify_attestation_status_accounting_preserved` — `total == pending +
   verified + revoked` under verify/revoke in any order.

All harnesses are enforced by the **Formal Verification (Kani)** job in
`.github/workflows/contracts.yml` (`cargo kani`). See
`contracts/indigopay-contract/VERIFICATION.md` for the harness-by-harness table
plus the encoding/range notes.

```bash
cd contracts/indigopay-contract/verification/kani && cargo kani
```

---

## Workstream 3 — Chaos engineering

Verifies the donation pipeline (wallet → Stellar → Soroban → event ingestion →
projection → leaderboard) survives and recovers from realistic infrastructure
failures without data loss, double-records, or incorrect state. The suite in
`test/chaos/` (orchestrated by `run-chaos.sh`, driven by `driver.js`, run nightly
via `chaos-nightly.yml`) has **six** scenarios:

| ID | Fault | Verifies |
|----|-------|----------|
| 01 | Redis container crash mid-spike | Cache degrades to misses (no 500s); donations persist; cache restored on restart |
| 02 | Postgres failover during donation | Clean failure, zero partial writes; idempotency — no double-records |
| 03 | Horizon 503 during keeper cycle | Clean failure, schedule preserved; retry+backoff, breaker opens; eventual recording, no double-record |
| 04 | Soroban RPC timeout | Retried with backoff; breaker OPEN fast-fails; eventual success; breaker CLOSED |
| 05 | **Network partition** (backend↔Redis) | Cache reads miss (never hang/throw); rate limiter falls back to in-memory; reconnects cleanly, cache not poisoned |
| 06 | **Cascading** (Redis + Postgres + Horizon 503) | Degraded-but-functional; every component recovers independently; zero data loss / zero double-records |

Scenarios 05 and 06 are the donation-pipeline legs added under #1101 WS3
(`test/chaos/scenarios/05-redis-partition.js`, `06-cascading.js`).

```bash
bash test/chaos/run-chaos.sh
```

---

## Workstream 5 — Visual regression

The frontend catches CSS/layout/theme regressions by diffing committed Playwright
screenshots (`frontend/e2e/visual.spec.ts`, baselines under
`frontend/e2e/visual.spec.ts-snapshots/`) against every PR. The dedicated
`.github/workflows/frontend-visual.yml` job enables the normally-CI-skipped spec
(`VISUAL_REGRESSION=1`) on a Chromium-only, pinned rendering image and fails the
job on any pixel diff; a reviewed `workflow_dispatch` regenerates baselines with
`--update-snapshots`. See `frontend/VISUAL_REGRESSION.md` for the maintenance
flow and how to extend coverage (light/dark × desktop/mobile across critical
pages).

```bash
cd frontend
npx playwright test -c playwright.v2.config.ts --grep "Visual regression"
```

---

## Workstream 7 — End-to-end synthetic transaction monitoring

The backend already runs a server-side synthetic monitor
(`scripts/synthetic-monitor.js`, `monitoring/alert-rules.yml`, `.github/workflows/synthetic-monitor.yml`)
that exercises the Horizon + Soroban RPC + API layers. WS7 closes the browser
gap by running the full **user-surface** donation synchronously:
`frontend/tests/e2e/synthetic-donation.spec.ts` walks page load → project detail
→ wallet connect → form → preview → confirm → dashboard → leaderboard, reusing
the same mock/selector patterns as the rest of `frontend/tests/e2e/` so it runs
in the existing `frontend-e2e` CI job.

---

## Local verification

```bash
# Backend jest (WS4 + WS6, and the rest of the backend suite)
cd backend && npm ci && npm test

# Offline API fuzz self-test against the real spec (WS4, PR CI)
cd .. && node scripts/validate-openapi.js --fuzz 100

# Contracts: cross-contract + attestation fuzz (WS2) and cargo test
cd contracts && cargo test --features testutils --workspace

# Kani formal verification (WS1)
cd contracts/indigopay-contract/verification/kani && cargo kani

# Chaos suite (WS3) — requires Docker
cd .. && bash test/chaos/run-chaos.sh

# Visual regression (WS5) — regenerates/admits baselines
cd frontend && npx playwright test -c playwright.v2.config.ts --grep "Visual regression"
```
