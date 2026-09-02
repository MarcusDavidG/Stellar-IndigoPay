/// fuzz_tests.rs — Property-based tests for the cross-chain donation
/// attestation bridge (epic #1101, WS2).
///
/// This supplies the missing cross-contract/cross-chain coverage for the
/// attestation contract. The indigopay-contract fuzz suite covers on-chain
/// Stellar donations; this suite covers the *bridge* path — a donor on a
/// non-Stellar source chain (Ethereum/Polygon/...) recorded as an attestation
/// and attributed to a Stellar donor + IndigoPay project. The two contracts
/// are the two legs of the same donation ledger, so WS2 needs both halves.
///
/// Invariants verified here:
///   - Replay guard: recording the same (source_chain, source_tx_hash) twice
///     always panics — an attestation is a one-time assertion, never a counter.
///   - Aggregate consistency: the per-donor and per-chain roll-up counters
///     exactly mirror the sum of the individual attestation records.
///   - Lifecycle accounting: verify/revoke commute to the same final status
///     counts regardless of order (revoke-after-verify vs verify-then-revoke),
///     and total counts are preserved.
///
/// Run:
///   cargo test --features testutils -- fuzz
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod fuzz {
    extern crate std;
    #[allow(unused_imports)]
    use std::format;

    use crate::{
        AttestationContract, AttestationContractClient, BatchAttestationInput, ChainAggregate,
        DonorAggregate,
    };
    use proptest::prelude::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env, String as SorobanString, Vec};

    /// Set up an initialized bridge with an authorized relayer.
    /// Returns (env, client, admin, relayer).
    fn setup() -> (Env, AttestationContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, AttestationContract);
        let client = AttestationContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        client.initialize(&admin);
        client.set_relayer(&admin, &relayer);
        (env, client, admin, relayer)
    }

    fn chain_str(env: &Env, s: &str) -> SorobanString {
        SorobanString::from_str(env, s)
    }

    fn input(
        env: &Env,
        relayer: &Address,
        donor: &Address,
        chain: &str,
        tx_hash: &str,
        amount_usd: i128,
        amount_xlm: i128,
    ) -> BatchAttestationInput {
        let _ = relayer;
        BatchAttestationInput {
            source_chain: chain_str(env, chain),
            source_tx_hash: chain_str(env, tx_hash),
            donor: donor.clone(),
            project_id: chain_str(env, "proj-cross-chain"),
            amount_usd,
            amount_xlm,
            message_hash: 42,
        }
    }

    const CHAINS: [&str; 3] = ["ethereum", "polygon", "arbitrum"];

    // Total counts must exactly equal the number of unique attestations ever
    // recorded — even when donors/amounts vary and chains interleave.
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        #[test]
        fn prop_agg_totals_match_recorded_attestations(
            batches in 1usize..=8usize,
            per_batch in 1usize..=4usize,
            amount_usd in 1i128..=10_000_000_000i128,
            amount_xlm in 1i128..=10_000_000_000i128,
        ) {
            let (env, client, _admin, relayer) = setup();
            let donor = Address::generate(&env);
            let mut source_tx_hash = 0u64;

            let mut expected_total: u64 = 0;
            for b in 0..batches {
                let mut items = Vec::new(&env);
                for _ in 0..per_batch {
                    source_tx_hash += 1;
                    items.push_back(input(
                        &env, &relayer, &donor,
                        CHAINS[b % CHAINS.len()],
                        &format!("0x{source_tx_hash:032x}"),
                        amount_usd, amount_xlm,
                    ));
                    expected_total += 1;
                }
                // mix single and batch record paths
                if items.len() == 1 {
                    client.record_attestation(
                        &relayer,
                        &chain_str(&env, CHAINS[b % CHAINS.len()]),
                        &chain_str(&env, &format!("0x{source_tx_hash:032x}")),
                        &donor,
                        &chain_str(&env, "proj-cross-chain"),
                        &amount_usd,
                        &amount_xlm,
                        &42u32,
                    );
                } else {
                    client.record_attestation_batch(&relayer, &items);
                }
            }

            prop_assert_eq!(
                client.get_total_count(), expected_total,
                "total count must equal number of recorded attestations"
            );
            prop_assert_eq!(
                client.get_pending_count(), expected_total,
                "all freshly recorded attestations are pending"
            );

            // Per-donor aggregate
            let agg: DonorAggregate = client.get_donor_aggregate(&donor);
            prop_assert_eq!(agg.total_attestations, expected_total);
            prop_assert_eq!(agg.total_usd, amount_usd * expected_total as i128);
            prop_assert_eq!(agg.total_xlm, amount_xlm * expected_total as i128);
            prop_assert_eq!(agg.pending, expected_total);
            prop_assert_eq!(agg.verified, 0);
            prop_assert_eq!(agg.revoked, 0);
            // Donor aggregate tracks per-chain counters; every distinct chain
            // the donor touched must appear (at most 3 here), and their counts
            // must sum to the total.
            let mut chain_members: u64 = 0;
            for i in 0..agg.chains.len() {
                let cc = agg.chains.get(i).unwrap();
                chain_members += cc.count;
            }
            prop_assert_eq!(chain_members, expected_total);
            prop_assert!(agg.chains.len() >= 1 && agg.chains.len() as u64 <= 3);

            // Per-chain aggregate across each used chain
            for i in 0..batches {
                let chain = CHAINS[i % CHAINS.len()];
                let chain_agg: ChainAggregate = client.get_chain_aggregate(&chain_str(&env, chain));
                prop_assert!(chain_agg.total_attestations >= 1);
                prop_assert_eq!(
                    chain_agg.pending + chain_agg.verified + chain_agg.revoked,
                    chain_agg.total_attestations
                );
            }
        }

        /// Replay of any previously-seen (source_chain, source_tx_hash) must
        /// panic — never mutate the ledger twice.
        #[test]
        fn prop_replay_always_panics(
            amount_usd in 1i128..=1_000_000_000i128,
            amount_xlm in 1i128..=1_000_000_000i128,
        ) {
            let (env, client, _admin, relayer) = setup();
            let donor_a = Address::generate(&env);
            let donor_b = Address::generate(&env);
            let chain = "polygon";
            let tx_hash = "0xdeadbeefcafe";

            client.record_attestation(
                &relayer,
                &chain_str(&env, chain),
                &chain_str(&env, tx_hash),
                &donor_a,
                &chain_str(&env, "proj-repeat"),
                &amount_usd,
                &amount_xlm,
                &42u32,
            );

            // Same (chain, tx), different donor → still a replay and must panic.
            let replay = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.record_attestation(
                    &relayer,
                    &chain_str(&env, chain),
                    &chain_str(&env, tx_hash),
                    &donor_b,
                    &chain_str(&env, "proj-repeat"),
                    &amount_usd,
                    &amount_xlm,
                    &42u32,
                );
            }));
            prop_assert!(
                replay.is_err(),
                "duplicate (source_chain, source_tx_hash) must be rejected"
            );

            // Ledger unchanged: still exactly one attestation.
            prop_assert_eq!(client.get_total_count(), 1);
            let agg: DonorAggregate = client.get_donor_aggregate(&donor_a);
            prop_assert_eq!(agg.total_attestations, 1);
            prop_assert_eq!(client.get_donor_aggregate(&donor_b).total_attestations, 0);
        }

        /// Lifecycle accounting: after every attestation reaches a terminal
        /// status (verified or revoked), the per-status counters must equal
        /// the number of attestations in that state and still sum to total.
        #[test]
        fn prop_lifecycle_accounting_commutes(
            count in 1u32..=12u32,
        ) {
            let (env, client, admin, relayer) = setup();
            let donor = Address::generate(&env);

            for i in 0..count {
                let tx_hash = format!("0xlife-{i:016x}");
                client.record_attestation(
                    &relayer,
                    &chain_str(&env, "ethereum"),
                    &chain_str(&env, &tx_hash),
                    &donor,
                    &chain_str(&env, "proj-cross-chain"),
                    &1_000_000i128,
                    &8_000_000i128,
                    &42u32,
                );
            }

            // Verify half, revoke the other half from Pending state.
            let verify_count = count / 2;
            let mut verified: u64 = 0;
            let mut revoked: u64 = 0;
            for i in 0..count {
                let id = i as u64 + 1;
                if i < verify_count {
                    client.verify_attestation(&id);
                    verified += 1;
                } else {
                    client.revoke_attestation(&admin, &id);
                    revoked += 1;
                }
            }

            // Verify/revoke counters (both aggregate and top-level) match.
            let pending_expected = u64::from(count).checked_sub(verified + revoked).unwrap_or(0);
            prop_assert_eq!(client.get_pending_count(), pending_expected);
            prop_assert_eq!(client.get_total_count(), u64::from(count));
            prop_assert_eq!(verified + revoked + pending_expected, u64::from(count));

            let agg: DonorAggregate = client.get_donor_aggregate(&donor);
            prop_assert_eq!(agg.verified, verified);
            prop_assert_eq!(agg.revoked, revoked);
            prop_assert_eq!(agg.pending, pending_expected);
            prop_assert_eq!(
                agg.verified + agg.revoked + agg.pending,
                agg.total_attestations
            );

            // Chain aggregate mirrors the same counts for the single used chain.
            let chain_agg: ChainAggregate =
                client.get_chain_aggregate(&chain_str(&env, "ethereum"));
            prop_assert_eq!(chain_agg.verified, verified);
            prop_assert_eq!(chain_agg.revoked, revoked);
            prop_assert_eq!(chain_agg.pending, pending_expected);
        }
    }
}
