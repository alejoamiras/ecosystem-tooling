/**
 * @alejoamiras/quota-paymaster — browser-safe SDK for the QuotaFpc paymaster.
 *
 * No node-only imports anywhere under this entrypoint. Operator tooling
 * (deploy, policy, bridge, claim, measure) is Node-only and lives behind the
 * separate `./operator` export.
 *
 * Human-facing copy is deliberately NOT part of this SDK: it exposes
 * structured reasons ({@link QuotaUnavailableError}); ready-made copy
 * templates live in the package's examples.
 */

export {
  type AllowanceState,
  assertNotBlocked,
  awaitAllowanceTransition,
  type FeeSource,
  type FeeSourceInputs,
  type OnSyncingPolicy,
  resolveFeeSource,
} from './allowance.js';
export { createSendOnceContext, type SendOnceContext } from './client/send-once.js';
export {
  MAX_ALLOWED_ACCOUNT_CLASSES,
  MAX_ALLOWED_TARGETS,
  padAllowedAccountClasses,
  padAllowedTargets,
  parseQuotaFpcConfig,
  type QuotaFpcAccountClass,
  type QuotaFpcConfig,
  QuotaFpcConfigError,
  type QuotaFpcPolicy,
  type QuotaFpcTarget,
  worstCasePerDayWei,
} from './config/schema.js';

export { humanizeDuration, inAbout, resetsIn } from './duration.js';
export {
  QuotaUnavailableError,
  type QuotaUnavailableReason,
  reasonFromRevert,
} from './errors.js';
export {
  assertValidGasProfile,
  DARK_FOREST_REFERENCE_GAS_PROFILE,
  type GasProfile,
  sponsoredFeeFloorWei,
} from './gas-profile.js';
export {
  generationAt,
  generationEndsAt,
  isGenerationStale,
  millisUntilReset,
  ROLLOVER_GRACE_SECONDS,
  resetLabel,
  SECONDS_PER_DAY,
  sponsorableGenerations,
} from './generation.js';
export {
  computePlayerNullifier,
  computeSeatNullifier,
  PLAYER_NULLIFIER_SEPARATOR,
  SEAT_NULLIFIER_SEPARATOR,
} from './nullifiers.js';
export {
  ACCOUNT_MAX_CALLS,
  buildSandwichPayload,
  FEE_PAYMENT_EXTERNAL,
  type QuotaFpcMethods,
  type SandwichInteraction,
  type SandwichRequest,
  type SandwichWallet,
} from './sandwich.js';
export {
  assertValidMaxUsers,
  countAvailableSeats,
  findFreeSeat,
  hasSubscribed,
  type SeatProbeNode,
  type SeatQuery,
  takenSeats,
} from './seat-picker.js';
