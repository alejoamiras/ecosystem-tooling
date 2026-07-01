// pay_fee()
// Deducts max_gas_cost from sender's balance. No refund of unused gas.
//
// All tests in this file are blocked due to TXE limitations.
// end_setup() breaks TXE kernel simulation; gas settings are zero in TXE so
// max_gas_cost is always 0, making balance deduction a no-op.
//
// Full coverage of pay_fee lives in the TypeScript integration tests (private.test.ts),
// which run against a real Aztec sandbox with non-zero gas settings.

// BLOCKED_1 -- end_setup() breaks TXE kernel simulation
//
// #[test]
// unconstrained fn pay_fee_success_sufficient_balance() {
//     let (env, contract_address, user, _) = utils::setup();
//     // Seed internal balance via a mock mint (not possible without FeeJuice nullifier).
//     let balance_before = utils::get_balance(env, contract_address, user);
//     env.call_private(user, PrivateFPC::at(contract_address).pay_fee());
//     let balance_after = utils::get_balance(env, contract_address, user);
//     assert(balance_after < balance_before, "Balance should decrease after pay_fee");
// }

// BLOCKED_1_2 -- also needs non-zero gas for max_gas_cost > 0
//
// #[test(should_fail_with = "Balance too low")]
// unconstrained fn pay_fee_insufficient_balance() {
//     let (env, contract_address, user, _) = utils::setup();
//     // user has zero balance and non-zero gas cost -- must revert.
//     env.call_private(user, PrivateFPC::at(contract_address).pay_fee());
// }
