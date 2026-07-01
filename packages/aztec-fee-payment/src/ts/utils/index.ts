export type { FeeMultiplier } from "./gas.js";

// Gas calculation utilities
export {
  DEFAULT_FEE_MULTIPLIER,
  DEFAULT_GAS_ESTIMATE_PADDING,
  estimateGasSettings,
  maxFeesPerGasFromBaseFees,
  maxPriorityFeesPerGasFromMaxFees,
  maxGasCostFor,
} from "./gas.js";

// Deployment utilities
export { registerPrivateContract } from "./deploy.js";
