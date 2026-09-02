# Formal Verification of IndigoPay Contract (Kani)

This document describes the formal verification deliverables of **issue #1101,
Workstream 1** — proving — not just testing — that the critical accounting,
payout, pricing, and lifecycle invariants of the IndigoPay/Soroban protocol
hold under **all** bounded inputs, using [Kani](https://modelchecking.github.io/kani/)
(an automated model checker based on CBMC).

The Soroban contracts are host-bound (they depend on `Env`, ledger storage, and
authorized calls) and therefore cannot be compiled and executed under Kani. The
standard, sound alternative — and the approach used here — is to encode each
on-chain property as an **equivalent pure-function mirror** of the exact
checked arithmetic the contract performs, then prove the mirrored property over
unbounded input ranges. Because the mirror is faithful to the on-chain code
(`checked_add` / `checked_sub` / `checked_mul` / `checked_div` remain, exactly
as on-chain), a proof over the mirror is a proof over the on-chain operation.

## Proven invariants

All six harnesses live in `verification/kani/src/lib.rs` (plus the two WS1
additions below), and all are exercised in CI by the **Formal Verification
(Kani)** job of `.github/workflows/contracts.yml` (`cargo kani` in the
verification crate's standalone workspace).

| # | Harness | Property proven |
|---|---------|-----------------|
| 1 | `invariant_global_total` | `GlobalTotalRaised` accumulation never overflows in range and the running total always equals the reference sum (`Σ(project.total_raised)`). |
| 2 | `verify_payout_is_bounded_by_amount` | `compute_proportional_payout(amount, p)` never exceeds `amount` for any `p ≤ 100` — proven via the non‑negative residual `amount − payout`. |
| 3 | `verify_payout_sum_never_exceeds_amount` | Σ over released milestone payouts ≤ `amount` whenever Σ proportions ≤ 100 (escrow never owes more than it holds). |
| 4 | `verify_reverse_donation_accounting_restores_exactly` | `donate(a) → reverse(a)` restores global/project/donor totals to their pre‑donation values exactly. |
| 5 | `verify_twap_is_bounded_by_observed_prices` | The oracle TWAP sits between `min(observations)` and `max(observations)` for strictly positive weights. |
| 6 | `verify_badge_threshold_disjointness` | Badge‑tier thresholds are mutually disjoint (no amount maps to two tiers). |
| 7 | `verify_badge_tier_is_monotonic` **(WS1 #1101)** | Badge tier is monotonic: for `a1 ≤ a2`, `badge_rank(a1) ≤ badge_rank(a2)` — a donor's tier never decreases as their cumulative total grows. |
| 8 | `verify_attestation_status_accounting_preserved` **(WS1 #1101)** | Attestation lifecycle accounting: `total_attestations == pending + verified + revoked` is preserved under verify‑then‑revoke and direct‑revoke orderings. |

Harnesses 1–6 are the arithmetic mirrors that previously lived under the
"WS5 / #1095" label; harnesses 7–8 close the two remaining gaps the epic calls
out (badge monotonicity and attestation accounting). The escrow and oracle
properties are proven here because they are pure arithmetic — the escrow and
oracle contracts themselves are host-bound just like IndigoPay.

## Encoding notes (performance)

Proving the literal forms (`payout ≤ amount`, `min ≤ Σ(p·w)/Σ(w) ≤ max`) is
intractable for CBMC's SAT solver (product‑v‑s‑product comparisons and symbolic
division). Two sound reformulations make every harness provable in seconds:

1. **Escrow — i64 checked residual.** `Σ(payouts) ≤ amount` ⟺
   `amount − Σ(payouts) ≥ 0`. The residual is computed with `i64::checked_sub`
   and asserted `Some`; the assertion is non‑vacuous (it fails on any
   underflow) and avoids product‑v‑s‑product encodings.
2. **Oracle TWAP — difference form.** `min ≤ Σ(p·w)/Σ(w) ≤ max` ⟺ (integers,
   `wᵢ > 0`) `Σ((pᵢ − min)·wᵢ) ≥ 0 ∧ Σ((max − pᵢ)·wᵢ) ≥ 0`. The on‑chain
   `weighted_sum / total_weight` floor division is captured exactly by the
   equivalence.

## Verified ranges

- Donation / escrow amounts: `0 ≤ amount < u64::MAX / 4` — far beyond any real
  job (the contract is bounded by its 64 KB instance‑ledger entry).
- Oracle prices: `0 ≤ price ≤ 1_000_000` (× price scale).
- TWAP weights: `1 ≤ weight ≤ 1000` (strictly positive, as required).

## Running locally

```sh
cd contracts/indigopay-contract/verification/kani
cargo kani            # verifies every #[kani::proof] harness
```

A successful run exits 0 and writes the full report under `target/kani/`.

Run a single harness:

```sh
cargo kani --harness invariant_global_total
cargo kani --harness verify_badge_tier_is_monotonic
cargo kani --harness verify_attestation_status_accounting_preserved
cargo kani --harness verify_twap_is_bounded_by_observed_prices
```

## CI

`.github/workflows/contracts.yml` runs a **Formal Verification (Kani)** job on
every push/PR touching `contracts/**`: it installs `kani-verifier`, caches the
toolchain, runs `cargo kani`, and uploads `target/kani` as the
`kani-verification-report` artifact. Any proof failure fails CI.

## Adding new invariants

1. Add a pure `#[cfg(kani)]` mirror function for the on-chain operation.
2. Add a `#[cfg(kani)] #[kani::proof]` harness that samples inputs with
   `kani::any()`, constrains preconditions with `kani::assume(...)`, and
   asserts the property AFTER the operation.
3. For loops, add `#[kani::unwind(n)]` large enough to cover all paths.
4. Update this table and the module doc.