/**
 * @defi-wonderland/aztec-fee-payment
 *
 * Fee Payment Contracts (FPCs) for Aztec - enables private fee payment strategies.
 *
 * @example
 * ```typescript
 * import {
 *   PrivateFPCContract,
 *   FPCFeePaymentMethod,
 *   registerPrivateContract,
 * } from '@defi-wonderland/aztec-fee-payment';
 *
 * // Register (no deploy needed — fully private contract)
 * const fpc = await registerPrivateContract(wallet, salt);
 *
 * // Use FPCFeePaymentMethod after minting internal balance
 * await someContract.methods.doSomething()
 *   .send({
 *     fee: { paymentMethod: new FPCFeePaymentMethod(fpc.address) }
 *   });
 * ```
 */

export type { FeeMultiplier } from "./utils/index.js";

// Contract artifacts and type-safe wrappers
export {
  PrivateFPCContract,
  PrivateFPCContractArtifact,
} from "../artifacts/PrivateFPC.js";

// Fee payment method implementations
export {
  FPCFeePaymentMethod,
  PrivateMintAndPayFeePaymentMethod,
} from "./fee-payment-methods/index.js";

// Utilities for integrators
export {
  // Gas calculations
  DEFAULT_FEE_MULTIPLIER,
  DEFAULT_GAS_ESTIMATE_PADDING,
  estimateGasSettings,
  maxFeesPerGasFromBaseFees,
  maxPriorityFeesPerGasFromMaxFees,
  maxGasCostFor,
  // Deployment
  registerPrivateContract,
} from "./utils/index.js";
