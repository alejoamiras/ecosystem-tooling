/**
 * @alejoamiras/quota-paymaster/operator — Node-only operator library.
 *
 * Dependency-injected and headless: callers hand in node/L1 clients, wallets,
 * and a `confirm` gate; every state-changing call goes through an immutable
 * ActionPlan (confirm exactly what will be sent, revalidate before broadcast).
 * Nothing here reads process.env — environment resolution belongs to the CLI
 * adapter (repo-local, unpublished).
 *
 * Importing this from a browser bundle FAILS by design (node:fs, node:crypto).
 */
export {
  ActionAborted,
  type ActionPlan,
  ActionRevalidationFailed,
  type ConfirmAction,
  confirmAndRevalidate,
  createActionPlan,
} from './action-plan.js';
export {
  type BridgeDeps,
  type BridgeL1Client,
  type BridgeRequest,
  type BridgeResult,
  bridgeFeeJuice,
} from './bridge.js';
export {
  type ClaimDeps,
  type ClaimDetails,
  claimFeeJuice,
  findClaimInJournal,
} from './claim.js';
export {
  assertArtifactIsChainVerifiedClass,
  type DeployQuotaFpcDeps,
  type DeployQuotaFpcOptions,
  deployQuotaFpc,
  type ParsedQuotaFpcConfig,
  verifyAccountClassIds,
} from './deploy.js';
export { formatFeeJuiceWei } from './internal/format.js';
export {
  appendJournalRecord,
  BRIDGE_JOURNAL_FILE,
  closeJournalDir,
  DEFAULT_JOURNAL_DIR,
  type JournalHandle,
  type JournalRecord,
  openJournalDir,
  readJournalRecords,
  withJournalLock,
} from './internal/journal.js';
export { type MeasureDeps, type MeasureResult, measureSponsoredFee } from './measure.js';
export {
  cancelPendingPolicyChange,
  type PolicyDeps,
  type PolicyState,
  type PolicyValues,
  readPolicyState,
  type ScheduleChange,
  type ScheduleGuards,
  schedulePolicyChange,
} from './policy.js';
