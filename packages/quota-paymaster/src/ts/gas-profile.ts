/**
 * What a sponsored transaction is allowed to cost.
 *
 * TWO parties must agree on these numbers and a disagreement is invisible
 * until it costs somebody money:
 *
 *   - the client, which builds sponsored transactions with these gas limits, and
 *   - the operator tooling, which must refuse to set a per-transaction ceiling
 *     below what the client will actually try to spend.
 *
 * If the ceiling drops below the client's spend, EVERY sponsored transaction
 * becomes unprovable and users are charged their own gas instead — with no
 * on-chain error to point at, because the transaction never gets that far.
 *
 * There is deliberately NO default profile: gas budgets belong to the ACTION
 * being sponsored, and inheriting another app's numbers silently is exactly
 * the "budget from the harness, not the action" failure the source project
 * warns about. Measure your own actions (the operator library's measure tool
 * exists for this) and declare a profile. The Dark Forest numbers below are
 * exported as clearly-labeled REFERENCE data, not a default.
 */

/** The gas envelope one app's sponsored transactions are built with. */
export interface GasProfile {
  /** Data-gas ceiling. Far tighter than the L2 cap on Aztec, easy to exceed. */
  daGasLimit: number;
  /** L2-gas ceiling. */
  l2GasLimit: number;
  teardownDaGasLimit: number;
  teardownL2GasLimit: number;
  /** Absorbs fee movement between proving and inclusion. */
  feeHeadroomMultiplier: number;
}

export function assertValidGasProfile(profile: GasProfile): void {
  const positiveInt = (v: number, name: string) => {
    if (!Number.isInteger(v) || v <= 0) {
      throw new RangeError(`GasProfile.${name} must be a positive integer, got ${v}`);
    }
  };
  positiveInt(profile.daGasLimit, 'daGasLimit');
  positiveInt(profile.l2GasLimit, 'l2GasLimit');
  positiveInt(profile.teardownDaGasLimit, 'teardownDaGasLimit');
  positiveInt(profile.teardownL2GasLimit, 'teardownL2GasLimit');
  if (!Number.isFinite(profile.feeHeadroomMultiplier) || profile.feeHeadroomMultiplier < 1) {
    throw new RangeError(`GasProfile.feeHeadroomMultiplier must be >= 1, got ${profile.feeHeadroomMultiplier}`);
  }
}

/**
 * REFERENCE data: the profile the Dark Forest mainnet deployment was tuned
 * with (measured 2026-08-01; a real game move used ~65% of the 6M L2 budget).
 * Use it to sanity-check your own measurements — NOT as your profile.
 */
export const DARK_FOREST_REFERENCE_GAS_PROFILE: GasProfile = {
  daGasLimit: 50_000,
  l2GasLimit: 6_000_000,
  teardownDaGasLimit: 5_000,
  teardownL2GasLimit: 500_000,
  feeHeadroomMultiplier: 2,
};

/**
 * The smallest per-transaction ceiling that still lets a client using
 * `profile` transact at the given fee rates. Anything below this makes
 * sponsorship fail for everyone.
 *
 * Mirrors the contract's own `assert_fee_within_max`, which bills
 * `gas_limits x max_fees_per_gas` and deliberately does NOT add teardown —
 * teardown is already reserved inside the limits at v5.0.1.
 */
export function sponsoredFeeFloorWei(profile: GasProfile, feePerDaGas: bigint, feePerL2Gas: bigint): bigint {
  assertValidGasProfile(profile);
  const perTx = BigInt(profile.daGasLimit) * feePerDaGas + BigInt(profile.l2GasLimit) * feePerL2Gas;
  return perTx * BigInt(profile.feeHeadroomMultiplier);
}
