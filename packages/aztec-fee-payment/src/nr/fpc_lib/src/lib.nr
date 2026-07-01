use aztec::context::PrivateContext;

/// Calculates the worst-case gas cost from transaction gas settings.
///
/// Formula:
///   max_fee_per_da_gas * da_gas_limit + max_fee_per_l2_gas * l2_gas_limit
///
/// Teardown gas is intentionally excluded: the kernel's gas meter (gas_meter.nr)
/// already includes teardown allocation in the overall gas limit when computing
/// the transaction fee, so adding teardown_gas_limits again would double-count it.
///
/// `max_priority_fees_per_gas` is also excluded: following EIP-1559 semantics,
/// `max_fees_per_gas` already bounds the per-gas cost.
///
/// @param context The context of the private call
/// @return The maximum gas cost for the transaction
pub fn get_max_gas_cost(context: &mut PrivateContext) -> u128 {
    let gas_settings = context.gas_settings();

    let l2_gas_limit = gas_settings.gas_limits.l2_gas;
    let da_gas_limit = gas_settings.gas_limits.da_gas;

    let max_fee_per_da_gas = gas_settings.max_fees_per_gas.fee_per_da_gas;
    let max_fee_per_l2_gas = gas_settings.max_fees_per_gas.fee_per_l2_gas;

    max_fee_per_da_gas * (da_gas_limit as u128) + max_fee_per_l2_gas * (l2_gas_limit as u128)
}
