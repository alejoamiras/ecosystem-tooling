// mint_and_pay_fee(amount: u128, salt: Field, leaf_index: Field)
// Cold-start flow: proves a prior FeeJuice.claim nullifier, credits
// (amount - max_gas_cost) to the claimer, and sets the FPC as fee payer.
//
// Tests in this file are blocked for two reasons:
//   BLOCKED_A -- TXE cannot inject a FeeJuice-siloed nullifier into the
//                nullifier tree, so assert_nullifier_exists always fails.
//   BLOCKED_B -- TXE gas settings are all-zero, so max_gas_cost == 0 and
//                the amount < max_gas_cost assertion can never trigger.
//   BLOCKED_C -- end_setup() breaks TXE kernel simulation.
//
// Full coverage lives in the TypeScript integration tests (private.test.ts).

// BLOCKED_A + BLOCKED_C -- requires FeeJuice nullifier in tree and end_setup support.
// Successful cold-start: credits (amount - max_gas_cost) to claimer.
//
// #[test]
// unconstrained fn mint_and_pay_fee_success_credits_remainder() {
//     let (env, contract_address, user, _) = utils::setup();
//     let salt = utils::random_salt();
//     let amount: u128 = utils::MINT_AMOUNT;
//     let leaf_index: Field = 0;
//
//     // Prerequisite: FeeJuice.claim must have pushed the FeeJuice nullifier. TXE cannot seed it.
//
//     let balance_before = utils::get_balance(env, contract_address, user);
//     env.call_private(user, PrivateFPC::at(contract_address).mint_and_pay_fee(amount, salt, leaf_index));
//     let balance_after = utils::get_balance(env, contract_address, user);
//
//     // Credited amount minus gas cost (exact gas cost depends on settings).
//     assert(balance_after > balance_before, "Balance should increase");
//     assert(balance_after <= balance_before + amount, "At most full amount credited");
// }

// BLOCKED_A + BLOCKED_B + BLOCKED_C -- requires FeeJuice nullifier AND non-zero gas settings.
// When amount < max_gas_cost the explicit assert fires with a meaningful error.
//
// #[test(should_fail_with = "Amount too low to cover gas cost")]
// unconstrained fn mint_and_pay_fee_amount_lt_cost_assertion() {
//     let (env, contract_address, user, _) = utils::setup();
//     let salt = utils::random_salt();
//     // amount must be less than max_gas_cost -- requires non-zero gas in TXE (not supported).
//     let amount: u128 = 1;
//     let leaf_index: Field = 0;
//
//     // Prerequisite: FeeJuice.claim must have run first. TXE cannot seed it.
//
//     env.call_private(user, PrivateFPC::at(contract_address).mint_and_pay_fee(amount, salt, leaf_index));
// }
