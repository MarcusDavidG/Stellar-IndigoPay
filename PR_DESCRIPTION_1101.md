# PR Description

## Title
feat(testing): Testing & Quality Hardening Epic (all 7 workstreams, #1101)

## Linked issue
[#1101 — (Critical) Testing & Quality Hardening Epic](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/1101)

## Summary
Completes all **seven** workstreams of epic #1101, turning quality into a
continuous, machine-verified gate across contracts, backend, frontend, monitoring,
infrastructure, and cross-cutting. The branch consolidates the API-fuzz and
load-regression work (WS4 + WS6) with the cross-contract fuzz (WS2) and synthetic
browser monitoring (WS7), and adds the previously missing Kani formal
verification (WS1), donation-pipeline chaos scenarios (WS3), and CI-enforced
visual regression (WS5).

```
WS4 ── API fuzz / OpenAPI conformance          ── done + verified (jest + offline fuzz green)
WS6 ── k6 load-test regression detection       ── done + verified (jest green)
WS2 ── cross-contract invariant fuzzing        ── done (cargo suite, nightly CI job)
WS7 ── synthetic donation E2E monitoring       ── done (browser journey, existing e2e CI job)
WS1 ── Kani formal verification                ── made complete (VERIFICATION.md + 2 harnesses; CI job exists)
WS3 ── chaos engineering                       ── made complete (scenarios 05 + 06 added)
WS5 ── visual regression testing               ── made complete (CI workflow + baseline docs; suite existed local-only)
```

## Workstream by workstream

### Workstream 1 — Kani formal verification
`contracts/indigopay-contract/verification/kani/src/lib.rs` now carries **eight**
`#[kani::proof]` harnesses (proving the properties as pure-function mirrors of the
on-chain checked arithmetic): escrow single-payout and summed-milestone bounds,
oracle TWAP bounds, reverse-donation accounting restore, global-total
accumulation, badge-threshold disjointness, plus the two new WS1 additions —
`verify_badge_tier_is_monotonic` and `verify_attestation_status_accounting_preserved`.
`VERIFICATION.md` is rewritten to document every harness, the encoding rationale,
and verified ranges. Enforced in CI by the existing **Formal Verification (Kani)**
job in `.github/workflows/contracts.yml` (`cargo kani`).

### Workstream 2 — Cross-contract invariant fuzzing
`contracts/indigopay-contract/tests/cross_contract_fuzz.rs` deploys IndigoPay
together with the oracle, native/USDC assets, and the real attestation contract,
drives deterministic random call sequences, and asserts global accounting
invariants after every step (global total == Σ project totals, donation-record
count, monotonic badge tiers, attestation-settlement dedup, token-suspend
behavior, batched TTL extension). `contracts/attestation-contract/src/fuzz_tests.rs`
property-tests the bridge half (replay guard, aggregate consistency, lifecycle
accounting). Nightly `Cross-Contract Fuzz` CI job; `FUZZ_ITERATIONS`-scaled.

### Workstream 3 — Chaos engineering
`test/chaos/` extends the existing four fault-injection scenarios with the two
donation-pipeline scenarios the epic calls out:
- **05 `05-redis-partition.js`** — a true network *partition* (host severs the
  docker-network link to Redis; process stays up). Asserts cache reads miss
  without hanging/throwing, the rate limiter falls back to its in-memory gate,
  and everything recovers with the cache un-poisoned. Host side: a new
  `partition_dance` in `run-chaos.sh` using `docker network disconnect/connect`.
- **06 `06-cascading.js`** — Redis **and** Postgres stopped simultaneously plus
  Horizon 503. Asserts degraded-but-functional mid-cascade, independent recovery,
  and zero data loss / zero double-records. Host side: `cascade_dance`.

### Workstream 4 — API fuzz / OpenAPI conformance
`backend/scripts/api-fuzz/{values,validator,plan,conformance}.js` +
`scripts/validate-openapi.js` `--fuzz N` / `--live <baseUrl> N`. Schema-derived
valid+invalid payloads with per-case *guaranteed-invalid* semantics; live scans
assert no 5xx for invalid input, declared status codes, and response-body
conformance. **Verified green here:** `backend` jest suites (92 tests) and the
offline fuzz self-test (50–100 iterations/endpoint) both pass. Fast run in the
`openapi-lint` PR job; nightly full fuzz via `fuzz-nightly.yml`.

### Workstream 5 — Visual regression
The committed Playwright baseline suite (`frontend/e2e/visual.spec.ts` + committed
`...-linux` baselines) is CI-enforced by a new dedicated
`.github/workflows/frontend-visual.yml` job that opts it in (`VISUAL_REGRESSION=1`),
diffs every PR, and fails on pixel drift; a reviewer-gated `workflow_dispatch`
regenerates baselines with `--update-snapshots`. `frontend/VISUAL_REGRESSION.md`
documents the maintenance and extension flow. NOTE: baselines for **new** pages
still need to be generated locally / via the update dispatch before adding more
snapshot cases (see the doc).

### Workstream 6 — Load-test regression detection
`backend/scripts/load-test-compare.js` + `scripts/load-test-compare.js` CLI parse
k6 `--summary-export`, compare against the committed
`scripts/load-test-baseline.json`, and render a PR comment; thresholds warn >20%
p95 Δ (or throughput Δ < −10%) and block >50% p95 Δ / >500ms hard gate. k6 script
gains PR-profile `SCENARIO=pr`. Nightly `load-test-nightly.yml`. **Verified green
here:** the compare logic jest suite passes.

### Workstream 7 — Synthetic donation E2E monitoring
`frontend/tests/e2e/synthetic-donation.spec.ts` runs the full user-surface
donation — page load → project detail → wallet connect → donate form → confirm →
donor dashboard → leaderboard — reusing the established mock/selector patterns so
it runs deterministically in the existing `frontend-e2e` CI job (complements the
backend `scripts/synthetic-monitor.js`).

## Files changed (representative)
- Contracts: `verification/kani/src/lib.rs`, `VERIFICATION.md`, `tests/cross_contract_fuzz.rs`, `attestation-contract/src/fuzz_tests.rs`
- Backend testing: `scripts/api-fuzz/*`, `scripts/load-test-compare.js`, `__tests__/fuzz/*`, `__tests__/scripts/load-test-compare.test.js`
- Frontend: `tests/e2e/synthetic-donation.spec.ts`, `tests/e2e/fixtures/api.ts`, `e2e/visual.spec.ts`, `VISUAL_REGRESSION.md`
- Chaos: `test/chaos/scenarios/{05-redis-partition,06-cascading}.js`, `test/chaos/{driver.js,run-chaos.sh,README.md}`
- CI: `.github/workflows/{ci,fuzz-nightly,load-test-nightly,contracts}.yml` + new `frontend-visual.yml`
- Docs: `docs/quality-and-fuzzing.md`, `CHANGELOG.md`

## Verification status
- ✅ Backend jest — 92 tests pass (`__tests__/fuzz`, `__tests__/scripts`).
- ✅ Offline API fuzz self-test — exit 0, 1,150 invalid cases all correctly violate their schema.
- ⏳ Rust (WS1/WS2) and integration-heavy suites (WS3 docker, WS5 baselines,
  WS6 k6, WS7 Playwright browsers) need the repo CI / local heavy toolchain —
  not runnable in this sandbox (no cargo/Kani, k6, or Chromium here).

## Security & compatibility
- Synthetic-monitor logic uses testnet/dedicated accounts; no production endpoints
  are fuzzed (live conformance targets a dedicated `BASE_URL`).
- Kani proofs are bounded; harness mirrors stay faithful to on-chain checked
  arithmetic.
- Visual baselines use route-mounted fixture data only (no PII).
- All new chaos scenarios run in the isolated docker-compose.chaos topology.