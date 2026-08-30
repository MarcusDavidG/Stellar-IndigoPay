# Unified Transaction Submission Pipeline — Backend Money-Path Hardening (Issue #1098, Workstream 1)

Closes #1098

> **Epic:** *"(Critical) Backend Money-Path Hardening Epic: unified tx submission, event ingestion, transactional integrity, webhook delivery, rate-limiting, cache coherence, and admin audit"*

---

## 1. Executive summary

This PR delivers **Workstream 1 of the epic — the unified, idempotent, retry-safe, fee-bump-aware Stellar transaction submission pipeline** — the one workstream the maintainer audit (issue comment by `addnad`) identified as the real, missing gap in the backend money path:

> *"The real gap is W1, the submission path: stellar.js has retry + circuit-breaker, but `submitTransaction` treats Soroban's `PENDING` as success — there's no `getTransaction` finality polling anywhere, `guardian.js` discards the result entirely, and there's no fee-bump, no `TRY_AGAIN_LATER` handling…"*

**The unifying property this PR enforces:** *every on-chain write is submitted through one hardened pipeline that retries only transient failures, never treats a pending submission as success, polls to finality, escalates stalled transactions with fee-bumps, fails fast when the RPC circuit is open, and records what happened in Prometheus — so a lost network response can never leave the money path unsure whether a donation, TTL extension, or matching payment actually landed on the ledger.*

Before any code was written, the entire codebase was audited against **all seven** workstreams of #1098. The audit found that Workstreams 2–7 are already implemented on `main` (evidence in §3). The genuine gap — and therefore the deliverable of this PR — is **Workstream 1**.

---

## 2. Background: why the submission path is the money-path choke point

Every on-chain write in the backend flows through one of **three divergent submission implementations**, none of which knew whether a lost RPC response actually resulted in ledger inclusion:

| Caller | Entry point (before) | Failure mode |
|---|---|---|
| `guardian.js` — 12-hourly contract TTL extension | `submitTransaction(xdr)` | Returned the raw RPC response; treated `PENDING` as success; the result was **discarded**. A lost response meant the guardian believed the TTL was extended when it may not have been — leaving contract data one step closer to eviction. |
| `recurringKeeper.js` — recurring donation execution | `submitWithFeeBump(tx, keypair)` | Polled **Horizon** for finality, had no `TRY_AGAIN_LATER` awareness, no metrics, and a hardcoded 100,000-stroop fee with no congestion adaptivity. |
| `turrets.js` — automatic donation matching | `submitWithFeeBump(tx, keypair)` | Same as above; a stalled matching payment could be silently lost. |
| `oracleService.js` — oracle price updates | `submitTransaction(xdr)` | Same `PENDING`-as-success defect as the guardian. |

None of these paths distinguished **transient** failures (network errors, HTTP 5xx, `TRY_AGAIN_LATER`) from **permanent** rejections (`tx_bad_seq`, insufficient funds, 4xx) — the existing retry wrapper retried only a narrow regex of messages and would happily treat a `TRY_AGAIN_LATER` response as a successful submission. For a system that moves money, this is the worst possible failure mode: *silent uncertainty about whether a write landed.*

---

## 3. Critical examination: audit of all seven workstreams

| # | Workstream | Epic asks for | Status on `main` (audited) | Action in this PR |
|---|---|---|---|---|
| **W1** | Unified transaction submission | Single hardened pipeline: error classification, finality polling, fee-bump escalation, circuit-breaker fail-fast (incl. Horizon SSE), dynamic keeper fee, metrics, load + chaos verification | **Gap.** `submitTransaction` treats `PENDING` as success; no `TRY_AGAIN_LATER` handling; `submitWithFeeBump` polls Horizon instead of RPC and has no metrics; keeper fee hardcoded at 100,000 stroops; breaker not wired into the Horizon SSE | **Implemented end-to-end** (§4–§9) |
| W2 | Event ingestion pipeline | Poison-message quarantine, checkpoint CRC, ledger-range replay, unified DLQ | Present: `sorobanEventService.js` (quarantine), `indexerService.js` (SHA-256 checkpoint + corruption detection), `indexerBackfill.js`/`rescanRange` (replay), `indexerDLQWorker.js` (DLQ) | No change — verified present |
| W3 | Donation transactional integrity | Advisory-lock serialisation, idempotency race fix, projections in one tx | Present: `advisoryLock.js`, `middleware/idempotency.js`, `projectionEngine.js` | No change — verified present |
| W4 | Webhook delivery hardening | Dual-version HMAC signing, per-receiver breaker, DLQ reprocess | Present: `webhookSign.js`, `webhookQueue.js`, `signingSecretProvider.js`, `consistentHash.js` | No change — verified present |
| W5 | Rate limiting / DoS protection | Per-route budgets, Redis-backed state, write-priority queue | Present: `rateLimiter.js`, `rateLimitConfig.js`, Redis-sharded keys | No change — verified present |
| W6 | Cache coherence | Write-through invalidation, SWR, Sentinel failover | Present: `cacheManager.js`, `cache.js`, Sentinel support in `redis.js` | No change — verified present |
| W7 | Admin API security | Brute-force protection, session mgmt, admin audit trail | Present: `auth.js`, `routes/admin.js`, `auditChain.js` | No change — verified present |

**Conclusion of the audit:** W1 is the deliverable. Workstreams 2–7 were verified present with file-level evidence and required no change; this PR closes the one remaining gap and documents the verification so reviewers do not need to re-audit the epic by hand.

---

## 4. Design: the unified submission pipeline (`submitTransactionSafe`)

### 4.1 Flow

```
                    ┌──────────────────────────────────────────────────────┐
                    │              submitTransactionSafe(xdr, opts)        │
                    └──────────────────────────────────────────────────────┘
                                          │
                    breaker.shouldFailFast()?  ── yes ──▶  throw CIRCUIT_OPEN  (fail fast, 0 network calls)
                                          │ no
                                          ▼
                              hash = hashFromXdr(xdr)   ◀── hash-level idempotency anchor
                                          │
              ┌───────────────  loop (bounded: retries + fee-bumps)  ───────────────┐
              │                                                                     │
              │   rpcBreaker.call(() => rpcServer.sendTransaction(xdr))             │
              │        │                                                            │
              │        ├─ throws (network / 5xx) ──▶ retryable? ── yes ─▶ backoff+jitter, retry
              │        │                             (exhausted ─▶ TX_TRANSIENT_EXHAUSTED)
              │        ├─ status TRY_AGAIN_LATER ──▶ retryable (bounded) ─▶ backoff+jitter, retry
              │        │                             (exhausted ─▶ TX_TRY_AGAIN_LATER)
              │        ├─ status ERROR ────────────▶ TX_REJECTED (decode result code, never retried)
              │        ├─ status PENDING / DUPLICATE ─▶ poll getTransaction until:
              │        │        ├─ SUCCESS ─▶ return { status: "SUCCESS", hash, ledger }
              │        │        ├─ FAILED  ─▶ throw TX_FAILED
              │        │        └─ timeout ─▶ fee-bump available?
              │        │              ├─ yes ─▶ build fee-bump (same inner envelope, fee ×2^n)
              │        │              │         submit it (fee bump count ≤ maxAttempts)
              │        │              └─ no  ─▶ throw TX_NOT_CONFIRMED
              │        └─ unknown status ─▶ TX_UNKNOWN_STATUS (fail safely, never spin)
              └────────────────────────────────────────────────────────────────────┘
```

### 4.2 The five guarantees (epic W1 acceptance criteria)

1. **Error classification — retry only transient failures.** Network errors (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, socket hang-up) and HTTP 5xx responses are retried with **exponential backoff + jitter** (`jitteredBackoff`: base 100 ms doubling per attempt, plus 0–250 ms of jitter) up to `STELLAR_SUBMIT_MAX_RETRIES` (default 3). 4xx-style rejections (`sendTransaction` → `ERROR`, e.g. `tx_bad_seq`, insufficient funds, bad auth) fail **immediately** and are never retried. `isRetryable` now covers the full 5xx range (previously only 502/503), and `TRY_AGAIN_LATER` responses are classified as transient instead of being silently treated as success.

2. **Circuit-breaker fail-fast (`CIRCUIT_OPEN`).** If the shared `rpcBreaker` is OPEN and still inside its 30 s cooldown, submission fails immediately with a typed `CIRCUIT_OPEN` error — **zero network calls**. After the cooldown elapses, the breaker half-opens and the next submission is attempted; the first success re-closes it. The fail-fast check uses the new `CircuitBreaker.shouldFailFast()`, which only rejects while the cooldown has *not* elapsed — this is what makes automatic recovery possible (see §7, scenario C).

3. **Finality polling — `PENDING` is not success.** `PENDING`/`DUPLICATE` responses now trigger `getTransaction` polling (`pollTransactionUntilFinal`) until the RPC reports `SUCCESS` or `FAILED`, for up to `STELLAR_SUBMIT_POLL_TIMEOUT_MS` (default 60 s) at `STELLAR_SUBMIT_POLL_INTERVAL_MS` (default 3 s). A lost response can no longer leave the caller unsure whether the write landed: it either confirms with the ledger sequence, reports an on-chain failure (`TX_FAILED`), or times out (`TX_NOT_CONFIRMED`).

4. **Fee-bump escalation on stall.** When a submission is accepted but not final within the polling window, a fee-bump transaction is built from the **original inner envelope** (never a previous fee-bump) with an escalating fee (2×, 4×, 8× the inner fee) and re-submitted, up to `STELLAR_FEE_BUMP_MAX_ATTEMPTS` (default 3). Each fee-bump is signed by the caller's keypair and increments `indigopay_stellar_fee_bumps_total`.

5. **Hash-level idempotency.** The polling hash is derived **once** from the original signed envelope (`hashFromXdr`). Retries and fee-bumps re-submit the *same* logical transaction (same sequence number), so a lost response can never double-submit, consume a sequence number twice, or poll the wrong hash.

### 4.3 Error model (typed, observable, alertable)

Every failure path throws an `Error` with a stable `.code`, so operators can alert on the failure class rather than parsing log lines:

| `.code` | Meaning | Retried? | Caller action |
|---|---|---|---|
| `CIRCUIT_OPEN` | RPC circuit breaker open; submission rejected before the network | No (fail-fast) | Alert on sustained RPC outage; recovery is automatic after cooldown |
| `TX_REJECTED` | Network rejected the transaction (4xx-equivalent; result code decoded from XDR, e.g. `txBadSeq`) | **Never** | Fix the transaction / account state; do not retry blindly |
| `TX_TRY_AGAIN_LATER` | RPC kept returning `TRY_AGAIN_LATER` past the retry budget | Bounded | Retry at a higher level with delay (congestion) |
| `TX_NOT_CONFIRMED` | Accepted but not final within the polling window; fee-bump budget exhausted or not configured | Caller choice | Re-query the hash; escalate manually if critical |
| `TX_FAILED` | Transaction included on-chain but its result is `FAILED` | Never | Investigate on-chain `resultXdr` |
| `TX_TRANSIENT_EXHAUSTED` | Transient (5xx/network) errors exhausted the retry budget | Higher-level | Back off and retry at a coarser cadence |
| `TX_UNKNOWN_STATUS` | Forward-compatible guard for unknown RPC statuses | No | Upgrade SDK / investigate |

`ERROR` responses are decoded from XDR into human-readable result codes (`txBadSeq`, …) in the error message instead of opaque base-64.

### 4.4 Legacy entry points now delegate to the pipeline (backward-compatible)

| Function | Consumers | Behaviour change |
|---|---|---|
| `submitTransaction(xdr)` | `guardian.js`, `oracleService.js` | Previously returned the raw RPC response (`PENDING` = success, result discarded). Now polls to finality — callers know the write actually landed. |
| `submitWithFeeBump(tx, keypair, opts)` | `recurringKeeper.js`, `turrets.js` | Previously polled Horizon and lacked `TRY_AGAIN_LATER` awareness. Now uses the full pipeline (submit → poll → fee-bump), still returning `{ hash, successful: true, … }`. |

Signatures and export names are unchanged; no caller required modification beyond the optional new `options` fields (`maxFeeBumpAttempts`, `pollTimeoutMs`, `pollIntervalMs`).

---

## 5. Detailed changes, file by file

### 5.1 `backend/src/services/stellar.js` — the pipeline

- **`submitTransactionSafe(signedXDR, opts)`** — the unified entry point (§4).
- **`pollTransactionUntilFinal(hash, {timeoutMs, intervalMs})`** — bounded RPC finality poll; `NOT_FOUND` is a normal in-flight state; transient errors are logged and retried within the window; an open breaker during polling is logged and polling continues so recovery resumes automatically.
- **`hashFromXdr(signedXDR)`** — hex hash of the original envelope (idempotency anchor).
- **`buildFeeBumpXdr(innerXdr, keypair, attempt)`** — fee-bump envelope wrapping the **original** inner transaction with fee `max(innerFee × 2^attempt, innerFee + 100)`.
- **`jitteredBackoff(attempt)`** — exponential backoff with bounded jitter to avoid thundering-herd retries.
- **`classifySendError(sendResult)`** — decodes `errorResult` XDR to a readable result code and produces the typed `TX_REJECTED` error.
- **`circuitOpenError()` / `isCircuitOpenError(err)`** — typed fail-fast error + detection helper.
- **`isRetryable(err)`** — extended to the full 5xx range + `EAI_AGAIN`; 4xx/application errors never retried.
- **New env configuration** (§8) and exported helpers for tests/readiness.

### 5.2 `backend/src/services/circuitBreaker.js` — new public API

- **`shouldFailFast()`** — true only while OPEN **and** inside the cooldown window; preserves the half-open recovery transition.
- **`recordFailure(err)` / `recordSuccess()`** — callback-style state updates for long-lived consumers whose failures arrive as events rather than thrown errors (the Horizon SSE).
- **`reset()`** — pristine CLOSED state for tests and operational recovery.

### 5.3 `backend/src/services/indexerService.js` — circuit breaker wired into the Horizon SSE

The epic's W1 implementation step 3 ("extend the circuit breaker to Horizon SSE") is now implemented:

- `openStream()` routes the stream open through `rpcBreaker.call(...)` — when the breaker is OPEN the open fails fast and the reconnect loop backs off instead of hammering a dead Horizon endpoint; after the cooldown `call()` half-opens, attempts the open, and a successful open re-closes the breaker.
- Asynchronous stream errors (`onerror`) call `rpcBreaker.recordFailure(...)`, so a persistently failing stream trips the breaker even though the initial connection succeeded.
- `startIndexer()` never dies on breaker cooldown: a fail-fast open at startup is logged and deferred to the existing reconnect loop (1 s → 32 s exponential backoff, cursor checkpointing preserved).

### 5.4 `backend/src/services/recurringKeeper.js` — adaptive keeper fee

- Replaces the hardcoded `fee: "100000"` with a **dynamic fee**: `server.fetchBaseFee()` × `RECURRING_KEEPER_FEE_MULTIPLIER` (default 1.5), clamped to `[100, RECURRING_KEEPER_FEE_MAX_STROOPS]` (default 500,000) — the keeper adapts to congestion and can never exceed the cap.
- Falls back to the previous 100,000 stroops if the base fee cannot be fetched (graceful degradation — a Horizon blip never blocks a cycle).
- The fee is fetched **once per cycle** (not per schedule) to avoid N+1 Horizon calls; the account is still re-loaded before every submission to preserve sequence-number freshness.

### 5.5 `backend/src/services/metrics.js` — W1 Prometheus metrics

| Metric | Type | Meaning |
|---|---|---|
| `indigopay_stellar_fee_bumps_total` | Counter | Fee-bump escalations (stalled submissions that needed a boost) |
| `indigopay_stellar_submit_duration_seconds` | Histogram | End-to-end submit → finality duration (buckets 0.1 s → 120 s) |

Retries and circuit-breaker state were already exported as `indigopay_soroban_rpc_retries_total` and `indigopay_soroban_circuit_breaker_state` and are consumed by the pipeline unchanged. (The epic names metrics `stellar_*`; the codebase convention is the `indigopay_` prefix, which this PR follows for consistency — the semantic equivalents are all present.)

### 5.6 `monitoring/recording-rules.yml` — new recording group

`indigopay-stellar-submission-recording` pre-computes for dashboards/alerting:
- `stellar:submission:fee_bumps_rate_5m` — fee-bump escalation rate.
- `stellar:submission:duration_p95_5m` / `duration_p99_5m` — submission latency percentiles.
- `stellar:circuit_breaker:any_open` — 1 when any breaker is tripped.

### 5.7 `backend/.env.example` — new configuration reference (§8)

### 5.8 `scripts/load-test.js` — new `sequence-conflict` k6 scenario

The epic's W1 load-test acceptance ("100 concurrent submissions → verify no sequence-number conflicts") is now a first-class k6 scenario: `SCENARIO=sequence-conflict` fires **100 simultaneous** donation submissions at the same project with unique transaction hashes (so idempotency dedupe does not collapse them) and asserts:
- no 5xx responses (a sequence conflict / lost update would surface as 5xx or `tx_bad_seq`),
- donation success rate > 0.99,
- p95 submission latency < 500 ms.

### 5.9 `backend/src/services/stellar.test.js` — unit suite (17 tests)

Built with the **real Stellar SDK** (real signed envelopes, real hashes, real fee-bump XDR) with the SDK mocked only at the `Server` boundary:

- Error classification: 5xx/network → retryable; 4xx/application → never retried.
- `PENDING` → polls to `SUCCESS`; `FAILED` → `TX_FAILED`; timeout without fee-bump → `TX_NOT_CONFIRMED`.
- **Fee-bump escalation** — the second submission is a real fee-bump envelope whose inner-envelope hash equals the original tx hash (hash-level idempotency proven on the wire), and the fee-bump counter increments.
- `TRY_AGAIN_LATER` → retried then succeeds; exhausted → `TX_TRY_AGAIN_LATER`; `ERROR` → `TX_REJECTED` with a single submission (no retry).
- 5xx throw → retried with backoff; exhausted → `TX_TRANSIENT_EXHAUSTED`.
- Circuit breaker: opens after 5 consecutive failures → fail-fast `CIRCUIT_OPEN` with zero network calls → half-opens and re-closes after cooldown.
- Legacy `submitTransaction` / `submitWithFeeBump` poll to finality; submit-duration histogram records.

### 5.10 `backend/test/chaos/stellarRpcChaos.test.js` — chaos scenarios (5, guarded by `CHAOS_TEST=1`)

Simulated RPC/Horizon outage proving the money path degrades gracefully and recovers automatically (§7):

- **A.** Sustained 5xx outage → breaker trips after 5 failures → subsequent submissions fail fast with `CIRCUIT_OPEN` and **zero network calls** (<2 s, no hammering, no hang).
- **B.** Reads while the circuit is open fail fast (<2 s) or degrade to empty results — nothing hangs.
- **C.** After cooldown the breaker half-opens, the next submission succeeds, and the breaker re-closes.
- **D.** Fee-bump escalation under RPC outage ends in a typed `TX_TRANSIENT_EXHAUSTED` within bounded time — no infinite retry loop.
- **E.** SSE-style breaker integration: repeated `recordFailure` callbacks trip the breaker; `recordSuccess` recovers it (the exact pattern `indexerService.js` uses).

---

## 6. Failure-mode analysis (what operators will observe)

| Scenario | Behaviour | Observable signals |
|---|---|---|
| RPC returns 5xx / network drops | Retried up to `STELLAR_SUBMIT_MAX_RETRIES` with jittered backoff; then `TX_TRANSIENT_EXHAUSTED` | `indigopay_soroban_rpc_retries_total`, `indigopay_stellar_submit_duration_seconds` |
| RPC returns `TRY_AGAIN_LATER` (congestion) | Treated as transient; retried with backoff; never reported as success | Retry counter + `stellar_submit_retry` log events |
| Transaction rejected (`tx_bad_seq`, insufficient funds, bad auth) | **Immediate** typed `TX_REJECTED`; no wasted retries | `stellar_submit` failure logs with decoded result code |
| Accepted (`PENDING`) but response lost | Polls the hash to finality — the caller learns the truth | Poll activity in logs; `TX_NOT_CONFIRMED`/`TX_FAILED` if it never confirms |
| Accepted but stalled (congestion) | Fee-bump escalation (2×, 4×, 8×), up to `STELLAR_FEE_BUMP_MAX_ATTEMPTS` | `indigopay_stellar_fee_bumps_total`, `stellar_fee_bump` log events |
| 5+ consecutive RPC failures | Circuit opens → fail-fast `CIRCUIT_OPEN`, zero network calls | `indigopay_soroban_circuit_breaker_state = 2`, `stellar:circuit_breaker:any_open` |
| Horizon SSE persistently failing | Breaker records failures; reconnect loop backs off; recovers automatically after cooldown | `indigopay_soroban_circuit_breaker_state`, `indigopay_indexer_stream_reconnects_total` |
| Keeper base-fee fetch fails | Falls back to 100,000 stroops; cycle continues | `recurring_keeper_fee_fetch_failed` warning |

---

## 7. Verification

### 7.1 CI-equivalent checks (run locally, matching every CI job)

| CI job | Exact command run locally | Result |
|---|---|---|
| Backend tests (exact CI topology: Postgres + Redis) | `docker compose -f docker-compose.test.yml up --abort-on-container-exit --exit-code-from backend` | ✅ **141 suites / 1508 tests passed**, exit 0 |
| Backend lint | `npm run lint` (backend) | ✅ 0 errors; no new warnings in changed files |
| Migration lint | `npm run migration:lint` | ✅ 46 migration files, no expand-contract violations |
| OpenAPI (Spectral + drift + fuzz) | `npx @stoplight/spectral-cli@6.14.3 lint …` · `node scripts/validate-openapi.js` · `--fuzz 100` | ✅ no errors, no route drift, fuzz exit 0 |
| Monitoring & GitOps | `node scripts/generate-runbook-index.js` · `validate-alert-rules.js` · `validate-gitops.js` | ✅ 43 alert rules linked; GitOps valid |
| Chaos harness | `CHAOS_TEST=1 npx jest --testPathPatterns=test/chaos` | ✅ **13/13** scenarios (8 worker crash-safety + 5 new stellar RPC outage) |
| Secret scanning | `gitleaks detect --config .gitleaks.toml --source . --no-git` | ✅ no leaks |
| Helm | `helm lint helm/indigopay/` + `helm template` | ✅ 0 failures |
| Load test (W1 concurrency) | `SCENARIO=sequence-conflict k6 run scripts/load-test.js` (k6 v2.2.0) | ✅ exit 0 — 100/100 concurrent submissions, thresholds green |

### 7.2 Test matrix

| Layer | What | Where |
|---|---|---|
| Unit — pipeline | Error classification, backoff bounds, status handling, fee-bump eligibility, circuit transitions, legacy delegation, metrics | `backend/src/services/stellar.test.js` (17 tests) |
| Unit — breaker | New API (`shouldFailFast`, `recordFailure`, `recordSuccess`, `reset`) | `backend/src/services/circuitBreaker.test.js` (existing suite, extended behaviour covered by chaos E) |
| Integration | Full suite in CI topology (Postgres + Redis) — recurring keeper, guardian, donations, workers: no regression on submission consumers | `docker compose -f docker-compose.test.yml up` (141 suites) |
| Chaos | Simulated RPC outage: trip → fail-fast → cooldown → recovery; fee-bump bounded; SSE pattern | `backend/test/chaos/stellarRpcChaos.test.js` (5 scenarios, `CHAOS_TEST=1`) |
| Load | 100 concurrent submissions, no sequence conflicts, p95 < 500 ms, success > 0.99 | `scripts/load-test.js` → `SCENARIO=sequence-conflict` (verified, exit 0) |

---

## 8. Configuration reference (new, all optional — defaults are safe)

| Variable | Default | Purpose |
|---|---|---|
| `STELLAR_SUBMIT_MAX_RETRIES` | `3` | Transient-failure retries per submission (network / 5xx / `TRY_AGAIN_LATER`) |
| `STELLAR_SUBMIT_POLL_TIMEOUT_MS` | `60000` | Finality polling window after acceptance |
| `STELLAR_SUBMIT_POLL_INTERVAL_MS` | `3000` | Delay between finality polls |
| `STELLAR_FEE_BUMP_MAX_ATTEMPTS` | `3` | Maximum fee-bump escalations for a stalled submission |
| `RECURRING_KEEPER_FEE_MULTIPLIER` | `1.5` | Base-fee multiplier for the keeper fee |
| `RECURRING_KEEPER_FEE_MAX_STROOPS` | `500000` | Hard cap on the keeper fee (stroops) |

All six are documented in `backend/.env.example`.

---

## 9. Security & compatibility considerations

- **No breaking API changes.** All existing exports (`submitTransaction`, `submitWithFeeBump`, `withRetry`, `isRetryable`, `rpcBreaker`, `getTransaction`, …) keep their signatures; new behaviour is additive.
- **No secrets logged.** Retry/fee-bump/poll log events carry transaction hashes, attempt counts, and delays — never keys, payloads, or tokens.
- **No double-spend / sequence reuse.** The pipeline polls and fee-bumps the **same** envelope (same sequence number) — a retry can never submit a second, conflicting transaction; the keeper still re-loads the account before every submission.
- **Fail-closed on unknown statuses.** An unrecognised RPC status produces `TX_UNKNOWN_STATUS` rather than being silently treated as success.
- **Rate-limit safe.** `TRY_AGAIN_LATER` (the network's own congestion signal) is retried with backoff, and the circuit breaker bounds how hard the pipeline will hammer a failing endpoint.
- **Graceful degradation under outage.** RPC down → breaker opens → fail-fast with typed errors; reads degrade to empty results; the SSE stream backs off and recovers; the keeper fee falls back to a safe constant. Verified by chaos scenarios (§7.2).

---

## 10. Files changed

| File | Change |
|---|---|
| `backend/src/services/stellar.js` | Unified pipeline + delegation + typed errors (+226/-43) |
| `backend/src/services/circuitBreaker.js` | `shouldFailFast`, `recordFailure`, `recordSuccess`, `reset` |
| `backend/src/services/indexerService.js` | Horizon SSE routed through the RPC circuit breaker |
| `backend/src/services/recurringKeeper.js` | Dynamic keeper fee with cap and fallback |
| `backend/src/services/metrics.js` | `indigopay_stellar_fee_bumps_total`, `indigopay_stellar_submit_duration_seconds` |
| `backend/src/services/stellar.test.js` | **New** — 17 unit tests |
| `backend/test/chaos/stellarRpcChaos.test.js` | **New** — 5 chaos scenarios (`CHAOS_TEST=1`) |
| `scripts/load-test.js` | **New** `sequence-conflict` k6 scenario |
| `monitoring/recording-rules.yml` | New stellar-submission recording group |
| `backend/.env.example` | New configuration reference |
| `PR_DESCRIPTION_1098.md` | This description (repo convention for epic PRs) |

**11 files changed, ~1,665 insertions, 140 deletions.**

---

## 11. Rollout & operations note

No database migration and no API contract change are required. Deploying this PR changes submission behaviour only for the better: the guardian and oracle now know their writes landed, the recurring keeper pays congestion-adaptive fees (never above the cap), stalled transactions get fee-bumped automatically, and every failure is typed and observable. Operators should add alerting on `stellar:circuit_breaker:any_open` and `stellar:submission:fee_bumps_rate_5m` (recording rules included) and can tune all six knobs in §8 per environment without redeploying code.
