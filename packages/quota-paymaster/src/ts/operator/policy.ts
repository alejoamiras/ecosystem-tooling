/**
 * Reads and retunes a live paymaster's policy.
 *
 * The contract enforces the real invariants (admin gate, CAS, sanity, the 12h
 * delay); this module adds the operator-side judgment the contract cannot:
 * the client fee floor (a ceiling below what clients spend bricks sponsorship
 * with no on-chain error), the max-loss bound (enforced on UPDATES too, not
 * just deploys), the balance-vs-reserve report, and chain-time pending
 * detection (never Date.now — local clocks lie).
 */
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Wallet } from '@aztec/aztec.js/wallet';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';
import { QuotaFpcContract } from '../../artifacts/QuotaFpc.js';
import { assertValidTargetList, padAllowedTargets, worstCasePerDayWei } from '../config/schema.js';
import { type GasProfile, sponsoredFeeFloorWei } from '../gas-profile.js';
import { type ConfirmAction, confirmAndRevalidate, createActionPlan } from './action-plan.js';

export interface PolicyDeps {
  node: AztecNode;
  wallet: Wallet;
  /** The account simulations and sends run from. Must be the admin to schedule. */
  from: AztecAddress;
  fpcAddress: AztecAddress;
}

export interface PolicyValues {
  maxFeeWei: bigint;
  maxUses: number;
  maxUsers: number;
}

export interface PolicyState {
  admin: string;
  live: PolicyValues & { allowedTargets: string[] };
  scheduled: {
    values: PolicyValues;
    allowedTargets: string[];
    /** Chain timestamp at which the scheduled bundle takes/took effect. */
    activatesAt: bigint;
    /** Pass back as expectedRevision when scheduling. */
    revision: bigint;
    /** True when activatesAt is still ahead of CHAIN time. */
    pending: boolean;
  };
  /** Latest block's timestamp — the clock every judgment here uses. */
  chainTimestamp: bigint;
  balanceWei: bigint;
  /**
   * The sequencer admits a sponsored tx only if the fee payer holds the
   * worst-case fee for the CLIENT's gas envelope. Below this, a paymaster
   * sponsors NOTHING while looking funded.
   */
  sequencerReserveWei: bigint;
  currentFees: { feePerDaGas: bigint; feePerL2Gas: bigint };
}

interface RawBundle {
  max_fee: bigint;
  max_uses: number | bigint;
  max_users: number | bigint;
  allowed_targets: { toString(): string }[];
}

// simulate() may wrap its value in { result } depending on the call shape.
// biome-ignore lint/suspicious/noExplicitAny: version-loose simulation results
const unwrap = (raw: any) => raw?.result ?? raw;

function bundleValues(bundle: RawBundle): PolicyValues & { allowedTargets: string[] } {
  return {
    maxFeeWei: BigInt(bundle.max_fee),
    maxUses: Number(bundle.max_uses),
    maxUsers: Number(bundle.max_users),
    allowedTargets: bundle.allowed_targets.map((a) => a.toString()).filter((a) => !/^0x0+$/.test(a)),
  };
}

/** One consistent read pass: clock, then schedule, then live policy, then money. */
/**
 * Registers the deployed instance + THIS package's artifact in the wallet.
 * `.at()` alone does not put the artifact in a fresh PXE — reads then fail
 * with "No artifact registered for contract class …" (the class-id/artifact
 * split the source project lost days to).
 */
export async function registerQuotaFpcInWallet(deps: PolicyDeps): Promise<void> {
  const instance = await deps.node.getContract(deps.fpcAddress);
  if (!instance) {
    throw new Error(`No contract deployed at ${deps.fpcAddress.toString()} on this node`);
  }
  const { QuotaFpcContractArtifact } = await import('../../artifacts/QuotaFpc.js');
  await (deps.wallet as unknown as { registerContract(i: unknown, a: unknown): Promise<void> }).registerContract(
    instance,
    QuotaFpcContractArtifact,
  );
}

export async function readPolicyState(deps: PolicyDeps, gasProfile: GasProfile): Promise<PolicyState> {
  await registerQuotaFpcInWallet(deps);
  const fpc = await QuotaFpcContract.at(deps.fpcAddress, deps.wallet);
  const from = deps.from;

  // CHAIN time, never wall clock — a chain can sit hours off the local clock.
  // Ordering honesty (review finding #9): the clock is read FIRST, so an
  // activation landing between the clock read and the later reads can yield
  // `pending: true` for a bundle the live read already reflects — a spurious
  // "pending", never a missed one. The cancel path re-validates pending-ness
  // immediately before sending, which is where the verdict actually matters.
  const latest = await deps.node.getBlockData('latest');
  const chainTimestamp = BigInt(latest?.header?.globalVariables?.timestamp ?? 0);
  if (chainTimestamp === 0n) {
    throw new Error('Could not read the chain timestamp from the latest block');
  }
  const [scheduledRaw, adminRaw, livePolicyRaw, liveTargetsRaw, balanceRaw, fees] = await Promise.all([
    fpc.methods.get_scheduled_settings().simulate({ from }),
    fpc.methods.get_admin().simulate({ from }),
    fpc.methods.get_policy().simulate({ from }),
    fpc.methods.get_allowed_targets().simulate({ from }),
    import('@aztec/aztec.js/utils').then(({ getFeeJuiceBalance }) => getFeeJuiceBalance(deps.fpcAddress, deps.node)),
    deps.node.getCurrentMinFees(),
  ]);
  const [scheduledBundle, activatesAt, revision] = unwrap(scheduledRaw) as [RawBundle, bigint, bigint];
  const admin = unwrap(adminRaw) as { toString(): string };
  const livePolicy = unwrap(livePolicyRaw) as {
    max_fee: bigint;
    max_uses: number | bigint;
    max_users: number | bigint;
  };
  const liveTargets = unwrap(liveTargetsRaw) as { toString(): string }[];
  const balanceWei = BigInt(balanceRaw ?? 0n);
  const feePerDaGas = BigInt(fees.feePerDaGas);
  const feePerL2Gas = BigInt(fees.feePerL2Gas);
  const scheduledValues = bundleValues(scheduledBundle);

  return {
    admin: admin.toString(),
    live: {
      maxFeeWei: BigInt(livePolicy.max_fee),
      maxUses: Number(livePolicy.max_uses),
      maxUsers: Number(livePolicy.max_users),
      allowedTargets: liveTargets.map((a) => a.toString()).filter((a) => !/^0x0+$/.test(a)),
    },
    scheduled: {
      values: {
        maxFeeWei: scheduledValues.maxFeeWei,
        maxUses: scheduledValues.maxUses,
        maxUsers: scheduledValues.maxUsers,
      },
      allowedTargets: scheduledValues.allowedTargets,
      activatesAt: BigInt(activatesAt),
      revision: BigInt(revision),
      pending: BigInt(activatesAt) > chainTimestamp,
    },
    chainTimestamp,
    balanceWei,
    sequencerReserveWei: sponsoredFeeFloorWei({ ...gasProfile, feeHeadroomMultiplier: 1 }, feePerDaGas, feePerL2Gas),
    currentFees: { feePerDaGas, feePerL2Gas },
  };
}

export interface ScheduleChange {
  maxFeeWei?: bigint;
  maxUses?: number;
  maxUsers?: number;
  /** Full replacement target list (unpadded). Omit to keep the live list. */
  allowedTargets?: string[];
}

export interface ScheduleGuards {
  /** The operator's loss budget; worst-case/day above it refuses. */
  maxLossWei: bigint;
  /** Client gas envelope; a ceiling below its floor refuses. */
  gasProfile: GasProfile;
  /** Explicit overrides — each names the risk it accepts. */
  acceptCeilingBelowClientFloor?: boolean;
  acceptWorstCaseAboveMaxLoss?: boolean;
}

/**
 * Schedules a policy change (CAS-protected, effective 12h later). There is ONE
 * pending slot: scheduling REPLACES any not-yet-active change.
 */
export async function schedulePolicyChange(
  deps: PolicyDeps & { confirm: ConfirmAction },
  change: ScheduleChange,
  guards: ScheduleGuards,
  /** Extra abort condition checked with the CAS immediately before sending. */
  revalidateAlso?: () => Promise<string | undefined>,
): Promise<{ scheduledRevision: bigint }> {
  // Snapshot the caller-owned change BEFORE validating or confirming — with a
  // COPY of the target array, which would otherwise stay aliased to caller
  // memory: a confirmation callback mutating it after the digest was shown
  // would schedule targets the human never saw (post-impl audit finding #1).
  const requested = {
    maxFeeWei: change.maxFeeWei,
    maxUses: change.maxUses,
    maxUsers: change.maxUsers,
    allowedTargets: change.allowedTargets ? [...change.allowedTargets] : undefined,
  };

  // The UPDATE path enforces the SAME target rules as deploys (review finding
  // #4): without this, a typo'd address is silently TRUNCATED by the parser
  // into a different address than the plan showed, live 12h later.
  if (requested.allowedTargets) {
    assertValidTargetList(requested.allowedTargets);
  }

  const [state, info] = await Promise.all([readPolicyState(deps, guards.gasProfile), deps.node.getNodeInfo()]);

  const next: PolicyValues & { allowedTargets: string[] } = {
    maxFeeWei: requested.maxFeeWei ?? state.live.maxFeeWei,
    maxUses: requested.maxUses ?? state.live.maxUses,
    maxUsers: requested.maxUsers ?? state.live.maxUsers,
    allowedTargets: requested.allowedTargets ?? [...state.live.allowedTargets],
  };

  // The floor the CLIENT will actually spend against. Below it, every
  // sponsored transaction becomes unprovable — with no on-chain error.
  const floor = sponsoredFeeFloorWei(guards.gasProfile, state.currentFees.feePerDaGas, state.currentFees.feePerL2Gas);
  if (next.maxFeeWei < floor && !guards.acceptCeilingBelowClientFloor) {
    throw new Error(
      `New maxFeeWei ${next.maxFeeWei} is below the client fee floor ${floor} at current ` +
        `fees — sponsorship would silently stop for everyone. Raise the ceiling, or pass ` +
        `acceptCeilingBelowClientFloor to do this deliberately (e.g. to pause sponsorship).`,
    );
  }
  // Max-loss holds on the UPDATE path too, not just at deploy.
  const worstCase = worstCasePerDayWei({
    maxFeeWei: next.maxFeeWei,
    maxUsesPerDay: next.maxUses,
    maxUsersPerDay: next.maxUsers,
  });
  if (worstCase > guards.maxLossWei && !guards.acceptWorstCaseAboveMaxLoss) {
    throw new Error(
      `New policy allows up to ${worstCase} wei/day (3 x maxFee x maxUses x maxUsers) but ` +
        `maxLossWei is ${guards.maxLossWei}. Lower the policy or pass ` +
        `acceptWorstCaseAboveMaxLoss to raise your exposure deliberately.`,
    );
  }

  const expectedRevision = state.scheduled.revision;
  const plan = createActionPlan('schedule-policy-change', {
    l1ChainId: info.l1ChainId,
    rollupVersion: info.rollupVersion,
    fpc: deps.fpcAddress.toString(),
    expectedRevision: expectedRevision.toString(),
    maxFeeWei: next.maxFeeWei.toString(),
    maxUses: next.maxUses,
    maxUsers: next.maxUsers,
    allowedTargets: next.allowedTargets.join(','),
    replacesPending: state.scheduled.pending,
    worstCasePerDayWei: worstCase.toString(),
    maxLossWei: guards.maxLossWei.toString(),
    activationDelayHours: 12,
  });

  const fpc = await QuotaFpcContract.at(deps.fpcAddress, deps.wallet);
  await confirmAndRevalidate(plan, deps.confirm, async () => {
    // The CAS the contract enforces, pre-checked with fresh eyes so a race
    // surfaces as a clean abort instead of a reverted transaction.
    const [[, , revisionNow], latestNow, infoNow] = await Promise.all([
      fpc.methods
        .get_scheduled_settings()
        .simulate({ from: deps.from })
        .then((raw) => unwrap(raw) as [RawBundle, bigint, bigint]),
      deps.node.getBlockData('latest'),
      deps.node.getNodeInfo(),
    ]);
    if (BigInt(revisionNow) !== expectedRevision) {
      return `revision moved ${expectedRevision} -> ${revisionNow} (another operator scheduled)`;
    }
    if (infoNow.l1ChainId !== info.l1ChainId || infoNow.rollupVersion !== info.rollupVersion) {
      return 'chain identity changed between reads';
    }
    // Activation race (post-impl audit finding #4): activating a pending
    // bundle does NOT bump the revision, so the CAS above cannot see it. If
    // the bundle we observed as pending has since crossed its activation
    // time, any omitted fields were filled from the PRE-activation live
    // policy — sending would schedule a 12h rollback to values the operator
    // never chose. Abort; the caller re-reads and rebuilds.
    const timeNow = BigInt(latestNow?.header?.globalVariables?.timestamp ?? 0);
    if (state.scheduled.pending && timeNow >= state.scheduled.activatesAt) {
      return 'the pending policy change activated mid-operation; re-read state and rebuild the change';
    }
    return revalidateAlso ? await revalidateAlso() : undefined;
  });

  const { AztecAddress: Addr } = await import('@aztec/aztec.js/addresses');
  const paddedTargets = padAllowedTargets(next.allowedTargets).map((a) => Addr.fromStringUnsafe(a));
  await fpc.methods
    .schedule_settings(
      {
        max_fee: next.maxFeeWei,
        max_uses: next.maxUses,
        max_users: next.maxUsers,
        allowed_targets: paddedTargets,
      },
      expectedRevision,
    )
    .send({ from: deps.from });

  return { scheduledRevision: expectedRevision + 1n };
}

/**
 * "Cancels" a pending change by scheduling the CURRENT live values — there is
 * no unschedule primitive on a delayed mutable. The live values still take a
 * fresh 12h trip.
 */
export async function cancelPendingPolicyChange(
  deps: PolicyDeps & { confirm: ConfirmAction },
  guards: ScheduleGuards,
): Promise<{ scheduledRevision: bigint }> {
  const state = await readPolicyState(deps, guards.gasProfile);
  if (!state.scheduled.pending) {
    throw new Error('nothing is pending — the last scheduled bundle is already in force');
  }
  return schedulePolicyChange(
    deps,
    {
      maxFeeWei: state.live.maxFeeWei,
      maxUses: state.live.maxUses,
      maxUsers: state.live.maxUsers,
      allowedTargets: state.live.allowedTargets,
    },
    // Re-scheduling what is already live cannot change exposure, but the
    // guards still run — live values must satisfy them or the operator should
    // know their standing policy no longer does.
    guards,
    // TOCTOU guard (review finding #5): if the pending change ACTIVATES
    // between the read above and the send, the CAS still passes (activation
    // does not bump the revision) and this call would schedule a 12h ROLLBACK
    // of the now-live policy while reporting a successful cancel. Abort
    // instead: re-read chain time and the activation timestamp just before
    // broadcasting.
    async () => {
      const stillPending = await readPolicyState(deps, guards.gasProfile);
      if (!stillPending.scheduled.pending) {
        return 'too late to cancel — the pending change already activated; scheduling now would ROLL BACK the live policy for 12h';
      }
      return undefined;
    },
  );
}
