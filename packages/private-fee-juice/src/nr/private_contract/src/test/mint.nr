// mint(amount: u128, salt: Field, leaf_index: Field)
// Proves a prior FeeJuice.claim nullifier exists, then credits internal FJ to the claimer.
//
// All tests in this file are blocked due to TXE limitations.
// TXE provides no oracle to inject a nullifier siloed under FEE_JUICE_ADDRESS into the
// nullifier tree. The assert_nullifier_exists() check inside mint() will always
// fail in the TXE environment because the FeeJuice claim nullifier cannot be pre-seeded.
//
// Full coverage of mint lives in the TypeScript integration tests (private.test.ts),
// which run against a real Aztec sandbox where FeeJuice.claim can be called first.

// BLOCKED -- TXE cannot inject a FeeJuice-siloed nullifier into the nullifier tree.
// The FeeJuice nullifier existence check (assert_nullifier_exists) is verified by the
// kernel circuit against the live nullifier tree; TXE has no oracle to seed it.
//
// #[test]
// unconstrained fn mint_success_credits_claimer() {
//     let (env, contract_address, user, _) = utils::setup();
//     let salt = utils::random_salt();
//     let amount: u128 = utils::MINT_AMOUNT;
//     let leaf_index: Field = 0;
//
//     // Prerequisite: FeeJuice.claim(FPC, amount, secret, leaf_index) must have run first,
//     // pushing its nullifier. TXE cannot simulate this.
//
//     let balance_before = utils::get_balance(env, contract_address, user);
//     env.call_private(user, PrivateFPC::at(contract_address).mint(amount, salt, leaf_index));
//     let balance_after = utils::get_balance(env, contract_address, user);
//
//     assert(balance_after == balance_before + amount, "Claimer balance should increase by amount");
// }

// BLOCKED -- depends on mint success (same TXE limitation as above).
//
// #[test(should_fail_with = "failed with duplicate nullifier")]
// unconstrained fn mint_double_spend_reverts() {
//     let (env, contract_address, user, _) = utils::setup();
//     let salt = utils::random_salt();
//     let amount: u128 = utils::MINT_AMOUNT;
//     let leaf_index: Field = 0;
//
//     // First call succeeds and pushes the FPC-scoped nullifier.
//     env.call_private(user, PrivateFPC::at(contract_address).mint(amount, salt, leaf_index));
//
//     // Second call with the same parameters fails -- FPC nullifier already exists.
//     env.call_private(user, PrivateFPC::at(contract_address).mint(amount, salt, leaf_index));
// }

// BLOCKED -- depends on mint success (same TXE limitation as above).
//
// #[test(should_fail)]
// unconstrained fn mint_wrong_claimer_reverts() {
//     let (env, contract_address, user, other) = utils::setup();
//     let salt = utils::random_salt();
//     let amount: u128 = utils::MINT_AMOUNT;
//     let leaf_index: Field = 0;
//
//     // `user` performed the L1 deposit and the FeeJuice.claim with their address as claimer.
//     // `other` tries to call mint -- their reconstructed nullifier doesn't match the
//     // one FeeJuice emitted, so the existence check fails.
//     env.call_private(other, PrivateFPC::at(contract_address).mint(amount, salt, leaf_index));
// }
