import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import { Gas, GasFees, GasSettings } from '@aztec/stdlib/gas';

type GasEstimationNode = {
  getCurrentMinFees(): Promise<GasFees>;
  getNodeInfo(): Promise<{
    txsLimits: { gas: { daGas: number; l2Gas: number } };
  }>;
};

/**
 * Raw gas consumed during simulation, returned by `simulate` when called with
 * `includeMetadata: true`. Replaces the removed `estimatedGas` result field.
 */
type SimulatedGasUsage = {
  totalGas: Gas;
  teardownGas: Gas;
};

type SimulatableInteraction = {
  simulate(options: {
    from: AztecAddress;
    additionalScopes?: AztecAddress[];
    includeMetadata?: boolean;
    fee?: {
      paymentMethod?: FeePaymentMethod;
      gasSettings?: {
        gasLimits?: Gas;
        teardownGasLimits?: Gas;
        maxFeesPerGas?: GasFees;
        maxPriorityFeesPerGas?: GasFees;
      };
    };
  }): Promise<{ gasUsed?: SimulatedGasUsage }>;
};

const FEE_MULTIPLIER_SCALE = 10_000n;
const DEFAULT_FEE_MULTIPLIER_NUMERATOR = 6n;
const DEFAULT_FEE_MULTIPLIER_DENOMINATOR = 5n;

export type FeeMultiplier =
  | number
  | {
      numerator: bigint;
      denominator: bigint;
    };

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function normalizeMultiplier(multiplier: FeeMultiplier): {
  numerator: bigint;
  denominator: bigint;
} {
  if (typeof multiplier === 'number') {
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new Error(`Fee multiplier must be a positive finite number, got ${multiplier}`);
    }

    return {
      numerator: BigInt(Math.ceil(multiplier * Number(FEE_MULTIPLIER_SCALE))),
      denominator: FEE_MULTIPLIER_SCALE,
    };
  }

  if (multiplier.denominator <= 0n || multiplier.numerator <= 0n) {
    throw new Error(
      `Fee multiplier must be a positive fraction, got ${multiplier.numerator}/${multiplier.denominator}`,
    );
  }

  return multiplier;
}

/**
 * Default max fee multiplier applied to the node's current minimum fees.
 * Represented as an exact 6/5 fraction so bigint fee values never depend on
 * floating-point multiplication.
 */
export const DEFAULT_FEE_MULTIPLIER = {
  numerator: DEFAULT_FEE_MULTIPLIER_NUMERATOR,
  denominator: DEFAULT_FEE_MULTIPLIER_DENOMINATOR,
} as const;

/**
 * Default padding applied to simulated gas usage when turning it into limits.
 */
export const DEFAULT_GAS_ESTIMATE_PADDING = 0.1;

// One-time nudge: fired at most once per process when estimateGasSettings is
// called without maxAcceptableGasCost. The FPC deducts the full max gas cost
// with no refund, so an unbounded node-reported fee is a real fund-loss vector;
// integrators should pass a client-side ceiling. Module-global by design (the
// warning is per-process advice, not per-call noise).
let hasWarnedNoGasCap = false;

/**
 * Pads each gas dimension by `pad` (e.g. 0.1 = +10%) and caps it at the
 * network's per-tx admission limit, mirroring the framework's getGasLimits.
 * The cap keeps the declared limits within what inbound validation accepts.
 */
function padAndClampGas(gas: Gas, pad: number, max: Gas): Gas {
  const padded = gas.mul(1 + pad);
  return Gas.from({
    daGas: Math.min(padded.daGas, max.daGas),
    l2Gas: Math.min(padded.l2Gas, max.l2Gas),
  });
}

/**
 * Calculate max fees per gas from the node's minimum fees with a multiplier.
 * @param baseFees - The current base fees from the node
 * @param multiplier - Multiplier to apply (default: DEFAULT_FEE_MULTIPLIER)
 * @returns GasFees object with calculated max fees
 */
export function maxFeesPerGasFromBaseFees(
  baseFees: {
    feePerDaGas: string | number | bigint;
    feePerL2Gas: string | number | bigint;
  },
  multiplier: FeeMultiplier = DEFAULT_FEE_MULTIPLIER,
): GasFees {
  const normalizedMultiplier = normalizeMultiplier(multiplier);

  return new GasFees(
    ceilDiv(BigInt(baseFees.feePerDaGas) * normalizedMultiplier.numerator, normalizedMultiplier.denominator),
    ceilDiv(BigInt(baseFees.feePerL2Gas) * normalizedMultiplier.numerator, normalizedMultiplier.denominator),
  );
}

/**
 * Mirror max fees into priority fees.
 * Aztec models both fee caps independently, but this SDK currently keeps them equal.
 */
export function maxPriorityFeesPerGasFromMaxFees(maxFeesPerGas: GasFees): GasFees {
  return maxFeesPerGas.clone();
}

/**
 * Calculate the maximum gas cost for a transaction.
 *
 * Teardown gas is already accounted for inside gasLimits by the protocol
 * (the kernel's gas_meter includes teardown in the overall fee computation),
 * so teardownGasLimits must NOT be added again here — doing so would
 * double-count the teardown cost.
 *
 * @param maxFeesPerGas - Maximum fees per gas unit
 * @param gasLimits - Gas limits for the transaction (already covers teardown allocation)
 * @returns Maximum possible gas cost in wei
 */
export function maxGasCostFor(maxFeesPerGas: GasFees, gasLimits: Gas): bigint {
  return (
    BigInt(maxFeesPerGas.feePerDaGas) * BigInt(gasLimits.daGas) +
    BigInt(maxFeesPerGas.feePerL2Gas) * BigInt(gasLimits.l2Gas)
  );
}

/**
 * Simulate an interaction to derive tighter gas limits, then combine them with
 * fee caps based on the node's current minimum fees.
 *
 * The network advertises the maximum gas a single tx may declare via
 * `NodeInfo.txsLimits.gas` (the smaller of the per-tx maximum and the per-block
 * allocation). The simulation runs within that ceiling and the simulated usage
 * is padded and clamped back to it, so the wallet's gas-limit validation never
 * rejects the resulting transaction for over-declaring gas.
 */
export async function estimateGasSettings(
  interaction: SimulatableInteraction,
  {
    aztecNode,
    from,
    paymentMethod,
    additionalScopes,
    maxFeeMultiplier = DEFAULT_FEE_MULTIPLIER,
    estimatedGasPadding = DEFAULT_GAS_ESTIMATE_PADDING,
    maxAcceptableGasCost,
  }: {
    aztecNode: GasEstimationNode;
    from: AztecAddress;
    paymentMethod?: FeePaymentMethod;
    additionalScopes?: AztecAddress[];
    maxFeeMultiplier?: FeeMultiplier;
    estimatedGasPadding?: number;
    /**
     * Optional absolute ceiling (in wei) on the transaction's worst-case gas
     * cost. When set, this helper throws if the node-derived settings would
     * declare a max cost above it — an independent, client-side check that does
     * NOT trust the connected node. Recommended: the FPC deducts the full max
     * gas cost with no refund, so a compromised/misconfigured node reporting an
     * inflated fee would otherwise drain the caller's balance. Omit at your own
     * risk (a one-time warning is emitted).
     */
    maxAcceptableGasCost?: bigint;
  },
): Promise<GasSettings> {
  // Validate the padding knob at the public boundary so we fail fast before the
  // simulation round-trip, mirroring the maxFeeMultiplier validation in
  // normalizeMultiplier. Zero is allowed (no margin); negatives would
  // under-declare gas and NaN/Infinity would yield invalid limits the node rejects.
  if (!Number.isFinite(estimatedGasPadding) || estimatedGasPadding < 0) {
    throw new Error(`Gas estimate padding must be a non-negative finite number, got ${estimatedGasPadding}`);
  }

  // Validate the cost ceiling at the boundary (must be a positive bigint when
  // provided); nudge once when it is omitted.
  if (maxAcceptableGasCost !== undefined) {
    if (typeof maxAcceptableGasCost !== 'bigint' || maxAcceptableGasCost <= 0n) {
      throw new Error(`maxAcceptableGasCost must be a positive bigint, got ${String(maxAcceptableGasCost)}`);
    }
  } else if (!hasWarnedNoGasCap) {
    hasWarnedNoGasCap = true;
    console.warn(
      'estimateGasSettings: called without maxAcceptableGasCost. A compromised or misconfigured RPC node ' +
        'can inflate the reported fee, and the FPC deducts the full max gas cost with no refund. ' +
        'Pass maxAcceptableGasCost (a positive bigint, in wei) to cap the client-declared cost.',
    );
  }

  const maxFeesPerGas = maxFeesPerGasFromBaseFees(await aztecNode.getCurrentMinFees(), maxFeeMultiplier);
  const maxPriorityFeesPerGas = maxPriorityFeesPerGasFromMaxFees(maxFeesPerGas);

  const {
    txsLimits: { gas },
  } = await aztecNode.getNodeInfo();
  const maxGasLimits = Gas.from({ daGas: gas.daGas, l2Gas: gas.l2Gas });

  const simulation = await interaction.simulate({
    from,
    additionalScopes,
    includeMetadata: true,
    fee: {
      paymentMethod,
      gasSettings: {
        gasLimits: maxGasLimits,
        teardownGasLimits: maxGasLimits,
        maxFeesPerGas,
        maxPriorityFeesPerGas,
      },
    },
  });

  if (!simulation.gasUsed) {
    throw new Error('Gas usage metadata was not returned by simulation.');
  }

  const { totalGas, teardownGas } = simulation.gasUsed;

  // If simulated usage already exceeds the admission limit the tx can never be
  // included, so fail fast rather than declaring a limit the node would reject.
  if (totalGas.daGas > maxGasLimits.daGas || totalGas.l2Gas > maxGasLimits.l2Gas) {
    throw new Error(
      `Transaction consumes more gas (DA ${totalGas.daGas}, L2 ${totalGas.l2Gas}) than the network admits per tx (DA ${maxGasLimits.daGas}, L2 ${maxGasLimits.l2Gas}).`,
    );
  }

  // gasLimits is the padded total gas (teardown is part of the total); the
  // teardown sub-limit is padded separately. Mirrors the framework's getGasLimits.
  const gasLimits = padAndClampGas(totalGas, estimatedGasPadding, maxGasLimits);
  const teardownGasLimits = padAndClampGas(teardownGas, estimatedGasPadding, maxGasLimits);

  // Enforce the caller's ceiling against the ACTUAL declared settings: the same
  // maxFeesPerGas + padded gasLimits the returned GasSettings carry, which is
  // exactly what the FPC recomputes and deducts on-chain (maxGasCostFor mirrors
  // the Noir get_max_gas_cost formula). Checking here — not against the node's
  // admission ceiling or the unpadded simulated usage — makes the cap
  // non-dodgeable. cost == cap is allowed (strict >).
  if (maxAcceptableGasCost !== undefined) {
    const projectedMaxCost = maxGasCostFor(maxFeesPerGas, gasLimits);
    if (projectedMaxCost > maxAcceptableGasCost) {
      throw new Error(
        `Estimated max gas cost ${projectedMaxCost} exceeds maxAcceptableGasCost ${maxAcceptableGasCost}. ` +
          'The connected node may be reporting an inflated fee; refusing to declare it (the FPC deducts the ' +
          'full max with no refund).',
      );
    }
  }

  return new GasSettings(gasLimits, teardownGasLimits, maxFeesPerGas, maxPriorityFeesPerGas);
}
