// =============================================================================
// Fee ceiling (handoff §6 gap — assert_fee_within_max was never exercised; the
// DF suite ran everything at MAX_FEE = 1e20). The assert mirrors the
// protocol's GasSettings.getFeeLimit(): gas_limits x max_fees_per_gas, WITHOUT
// adding teardown (already reserved inside gas_limits at v5.0.1).
// =============================================================================

use crate::QuotaFpc::assert_fee_within_max;
use aztec::protocol::abis::{gas::Gas, gas_fees::GasFees, gas_settings::GasSettings};

unconstrained fn settings(da_gas: u32, l2_gas: u32, fee_da: u128, fee_l2: u128) -> GasSettings {
    GasSettings {
        gas_limits: Gas::new(da_gas, l2_gas),
        teardown_gas_limits: Gas::new(0, 0),
        max_fees_per_gas: GasFees::new(fee_da, fee_l2),
        max_priority_fees_per_gas: GasFees::new(0, 0),
    }
}

#[test]
unconstrained fn fee_exactly_at_ceiling_is_accepted() {
    // 100 * 3 + 200 * 2 = 700
    assert_fee_within_max(settings(100, 200, 3, 2), 700);
}

#[test]
unconstrained fn fee_below_ceiling_is_accepted() {
    assert_fee_within_max(settings(100, 200, 3, 2), 701);
}

#[test(should_fail_with = "Gas settings exceed the sponsorship allowance")]
unconstrained fn fee_one_above_ceiling_is_rejected() {
    assert_fee_within_max(settings(100, 200, 3, 2), 699);
}

#[test(should_fail_with = "Gas settings exceed the sponsorship allowance")]
unconstrained fn tiny_ceiling_rejects_realistic_gas_settings() {
    // The reference gas profile's shape: 50k DA / 6M L2 at nonzero fees. A
    // 1-wei ceiling (the Phase-5 e2e deploys exactly this) must be unprovable.
    assert_fee_within_max(settings(50_000, 6_000_000, 1, 1), 1);
}

#[test]
unconstrained fn teardown_limits_do_not_inflate_the_bound() {
    // Teardown is NOT added on top (v5.0.1 billing); huge teardown limits must
    // not push an otherwise-affordable transaction over the ceiling.
    let mut s = settings(100, 200, 3, 2);
    s.teardown_gas_limits = Gas::new(1_000_000, 1_000_000);
    assert_fee_within_max(s, 700);
}
