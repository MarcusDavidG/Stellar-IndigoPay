# PR #1204 — Testing & Quality Hardening: all 7 workstreams of epic #1101 (WS1–WS7)

> Suggested title: `feat(testing): Testing & Quality Hardening — all 7 workstreams of epic #1101 (WS1–WS7)`

## Linked issue
[#1101 — (Critical) Testing & Quality Hardening Epic: Kani proofs, cross-contract fuzzing, chaos engineering, API fuzz, visual regression, load-test detection, and synthetic E2E monitoring](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/1101)

## Summary
Completes **all seven workstreams** of epic #1101, turning quality into a continuous, machine-verified gate across contracts, backend, frontend, monitoring, and cross-cutting layers. The branch consolidates the API-fuzz and k6 load-regression work (WS4 + WS6) with the cross-contract fuzz (WS2) and synthetic browser monitoring (WS7), and adds the previously missing **Kani formal verification (WS1)**, **donation-pipeline chaos scenarios (WS3)**, and **CI-enforced visual regression (WS5)**.

| WS | Workstream | Status |
|----|-----------|--------|
| 1 | Kani formal verification | Done (+2 harnesses, `VERIFICATION.md`, existing CI Kani job) |
| 2 | Cross-contract invariant fuzzing | Done (`cross_contract_fuzz.rs`, attestation `fuzz_tests.rs`, nightly job) |
| 3 | Chaos engineering | Done (+ network-partition & cascading scenarios) |
| 4 | API fuzz / OpenAPI conformance | Done — verified (jest + offline fuzz green) |
| 5 | Visual regression | Done (+ CI-enforced workflow, baseline docs) |
| 6 | k6 load-test regression detection | Done — verified (jest green) |
| 7 | Synthetic donation E2E monitoring | Done (browser journey in E2E CI) |

---

## Workstream 1 — Kani formal verification
`contracts/indigopay-contract/verification/kani/src/lib.rs` now carries **8** `#[kani::proof]` harnesses, proving the invariants as pure-function mirrors of the exact on-chain checked arithmetic (the Soroban contracts are host-bound and cannot run under Kani):

- `invariant_global_total` — `GlobalTotalRaised` accumulation never overflows; running total always equals the reference sum.
- `verify_payout_is_bounded_by_amount` — a proportional escrow payout never exceeds the job amount.
- `verify_payout_sum_never_exceeds_amount` — Σ(milestone payouts) ≤ amount whenever Σ proportions ≤ 100.
- `verify_reverse_donation_accounting_restores_exactly` — donate(a)→reverse(a) restores every counter exactly.
- `verify_twap_is_bounded_by_observed_prices` — oracle TWAP sits within `[min, max]` observed prices.
- `verify_badge_threshold_disjointness` → `verify_badge_tier_is_monotonic` — badge tiers are **disjoint** and **monotonic** (**new**).
- `verify_attestation_status_accounting_preserved` — `total == pending + verified + revoked` under verify/revoke in any order (**new**).

`contracts/indigopay-contract/VERIFICATION.md` is rewritten with a harness-by-harness table, the residual/difference encoding rationale, verified ranges, and CI notes. Enforced by the **Formal Verification (Kani)** job in `.github/workflows/contracts.yml` (`cargo kani`), which uploads the `kani-verification-report` artifact and fails on any proof failure.

## Workstream 2 — Cross-contract invariant fuzzing
- `contracts/indigopay-contract/tests/cross_contract_fuzz.rs` deploys IndigoPay together with the oracle, native/USDC assets, and the **real attestation contract**, then drives deterministic random sequences (`register_project`/`donate`/`donate_usdc`/attest `record → verify → settle`/`suspend_token`/`resume_token`/batched `bump_ttl`) and asserts global invariants after **every step**: global total == Σ project totals, donation-record count, monotonic badge tiers, attestation double-settle dedup, token-suspend blocking, and TTL-floor stability. Deterministic LCG + `FUZZ_ITERATIONS` scaling; the nightly **Cross-Contract Fuzz** CI job runs it with `FUZZ_ITERATIONS=250`.
- `contracts/attestation-contract/src/fuzz_tests.rs` property-tests the **bridge** half (a donor on a non-Stellar chain recorded as an attestation): **replay guard** (duplicate `(source_chain, source_tx_hash)` always panics, never mutates twice), **aggregate consistency** (per-donor/per-chain roll-ups exactly mirror recorded attestations), and **lifecycle accounting** (verify/revoke commute to the same status counts).

## Workstream 3 — Chaos engineering
`test/chaos/` (orchestrated by `run-chaos.sh`, driven by `driver.js`, nightly via `chaos-nightly.yml`) extends the four existing fault legs with the two donation-pipeline scenarios epic #1101 requires, for **six scenarios** total:

| ID | Fault | Verifies |
|----|-------|----------|
| 01 | Redis container crash mid-spike | Cache degrades to misses (no 500s); donations persist; cache restored |
| 02 | Postgres failover during donation | Clean failure, zero partial writes; idempotency — no double-records |
| 03 | Horizon 503 during keeper cycle | Clean failure, schedule preserved; retry+backoff, breaker opens; eventual recording, no double-record |
| 04 | Soroban RPC timeout | Retried with backoff; breaker OPEN fast-fails; eventual success |
| 05 | **Network partition** (backend↔Redis) | Cache reads miss (never hang/throw); rate limiter falls back in-memory; reconnects cleanly, cache not poisoned |
| 06 | **Cascading** (Redis + Postgres + Horizon 503) | Degraded-but-functional; every component recovers independently; zero data loss / zero double-records |

Scenarios 05 (`scenarios/05-redis-partition.js`) and 06 (`scenarios/06-cascading.js`) are new. Host-side `partition_dance` (via `docker network disconnect/connect`) and `cascade_dance` were added to `run-chaos.sh`; both are registered in `driver.js`. The partition scenario exercises the app's real `redis.get()` cache path, whose `enableOfflineQueue:false` + `maxRetriesPerRequest:0` client guarantees a severed-link read fails fast to a cache-miss.

## Workstream 4 — API fuzz / OpenAPI conformance
Dependency-free toolchain in `backend/scripts/api-fuzz/`:
- `values.js` — schema-aware **valid** + **invalid** value generation.
- `validator.js` — minimal JSON-Schema validator (proves valid cases are valid and invalid cases violate).
- `plan.js` — derives a per-operation fuzz plan from `docs/api/openapi.yaml`.
- `conformance.js` — live runner with **guaranteed-invalid** case construction (a mutation is kept only when the schema validator rejects it; wrong-root-type forced fallback).

`scripts/validate-openapi.js` adds `--fuzz N` (offline self-test: every labelled case is correct) and `--live <baseUrl> N` (no 5xx for invalid input, declared status codes, response-body conformance). **CI:** fast fuzz in the `openapi-lint` PR job; nightly full fuzz + optional live scan via `fuzz-nightly.yml`. ✅ **Verified here:** backend jest (92 tests) + offline fuzz self-test (1,150 invalid cases) all pass.

## Workstream 5 — Visual regression
Committed Playwright screenshot baselines (`frontend/e2e/visual.spec.ts-snapshots/`, tagged `-linux`) verified against every PR by a new dedicated `.github/workflows/frontend-visual.yml` job. The suite opts in via `VISUAL_REGRESSION=1` so ordinary frontend jobs keep skipping it (font-render flakiness) while the dedicated Chromium-pinned job **fails on any pixel drift**. A reviewer-gated `workflow_dispatch` regenerates baselines with `--update-snapshots`. `frontend/VISUAL_REGRESSION.md` documents the reviewer-approved baseline-update flow and how to extend page/theme/viewport coverage without PII. Baseline regeneration for **new** pages is a follow-up under the documented process.

## Workstream 6 — k6 load-test regression detection
- `backend/scripts/load-test-compare.js` + root `scripts/load-test-compare.js` CLI: parse k6 `--summary-export`, compare against the committed `scripts/load-test-baseline.json`, render a PR comment.
- Thresholds: warn >20% p95 Δ / throughput Δ < −10%; **block** >50% p95 Δ / >500ms hard gate.
- k6 script gains `SCENARIO=pr`, `PR_VUS`, `PR_DURATION` for lighter PR-load profiles.
- `scripts/load-test-baseline.json` refreshed nightly by the full-load job (`load-test-nightly.yml`); optional PR-comment via `workflow_dispatch`. ✅ **Verified here:** compare logic unit-tested green.

## Workstream 7 — End-to-end synthetic transaction monitoring
`frontend/tests/e2e/synthetic-donation.spec.ts` runs the full **user-surface** donation alongside the backend synthetic monitor: page load → project detail → wallet connect → donate form → confirm → donor dashboard → leaderboard. It reuses the established mock/selector patterns so it is deterministic in the existing `frontend-e2e` CI job, complementing the API/on-chain checks in `scripts/synthetic-monitor.js`.

---

## CI wiring
| Workstream | PR / fast path | Nightly / heavy path |
|-----------|----------------|----------------------|
| WS1 Kani | — | `contracts.yml` → Formal Verification (Kani) |
| WS2 fuzz | — | `contracts.yml` → Cross-Contract Fuzz |
| WS3 chaos | — | `chaos-nightly.yml` |
| WS4 API fuzz | `ci.yml` `openapi-lint` `--fuzz` | `fuzz-nightly.yml` (full + live) |
| WS5 visual | `frontend-visual.yml` (new) | workflow_dispatch baseline update |
| WS6 load test | `ci.yml` PR job | `load-test-nightly.yml` |
| WS7 synthetic e2e | existing `frontend-e2e` job | `synthetic-monitor.yml` (backend) |

## Files changed (representative)
- Contracts: `verification/kani/src/lib.rs`, `VERIFICATION.md`, attestation `fuzz_tests.rs`, `tests/cross_contract_fuzz.rs`
- Backend testing: `scripts/api-fuzz/*`, `scripts/load-test-compare.js`, `__tests__/fuzz/*`, `__tests__/scripts/load-test-compare.test.js`
- Frontend: `tests/e2e/synthetic-donation.spec.ts`, `tests/e2e/fixtures/api.ts`, `e2e/visual.spec.ts`, `VISUAL_REGRESSION.md`
- Chaos: `test/chaos/scenarios/{05-redis-partition,06-cascading}.js`, `test/chaos/{driver.js,run-chaos.sh,README.md}`
- CI: `.github/workflows/{ci,fuzz-nightly,load-test-nightly,contracts}.yml` + **new** `frontend-visual.yml`
- Docs: `docs/quality-and-fuzzing.md`, `CHANGELOG.md`, `PR_DESCRIPTION_1101.md`

## Verification status
- ✅ Backend jest — 92 tests pass (`__tests__/fuzz`, `__tests__/scripts`).
- ✅ Offline API fuzz self-test — exit 0; 1,150 invalid cases all correctly violate their schema.
- ⏳ Rust / Kani (WS1, WS2), Docker chaos (WS3), k6 (WS6), and Playwright (WS5, WS7) require the repo's real CI / heavy toolchains; they are implemented and will validate on the CI jobs above (not executable in a lightweight sandbox).

## Security & compatibility
- Live conformance fuzzing targets a dedicated `BASE_URL` (never production); synthetic-monitor logic uses testnet/dedicated accounts.
- Kani proofs are bounded; harness mirrors faithfully preserve on-chain `checked_*` semantics.
- Visual baselines use route-mocked fixture data only — no PII.
- All new chaos scenarios run inside the isolated `docker-compose.chaos.yml` topology.