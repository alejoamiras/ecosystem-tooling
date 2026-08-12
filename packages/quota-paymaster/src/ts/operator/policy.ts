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
import { TxStatus } from '@aztec/stdlib/tx';
import { QuotaFpcContract } from '../../artifacts/QuotaFpc.js';
import { assertValidTargetList, padAllowedTargets, U32_MAX, U128_MAX, worstCasePerDayWei } from '../config/schema.js';
import { type GasProfile, sponsoredFeeFloorWei } from '../gas-profile.js';
import {
  type ConfirmAction,
  confirmAndRevalidate,
  createActionPlan,
  digestOptions,
  snapshotOptions,
} from './action-plan.js';

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

/**
 * How close (in chain seconds) a pending bundle's activation may be before
 * scheduling refuses to proceed. Covers worst-case proving + broadcast +
 * inclusion latency between the revalidation read and the transaction
 * landing; 10 minutes is far above observed mainnet proving times.
 */
const ACTIVATION_SAFETY_HORIZON_SECONDS = 600n;

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
    // The profile's OWN headroom, not a stripped 1x: admission checks the fee
    // payer against GasSettings.getFeeLimit() = gas_limits x MAX_fees_per_gas,
    // and the client declares those maxima with headroom applied
    // (maxFeePerGasWithHeadroom). Reporting the 1x number understates the
    // reserve by the multiplier, so a paymaster funded between the two reads
    // as healthy and sponsors nothing — the exact failure this line exists to
    // catch (round-7 finding 1).
    sequencerReserveWei: sponsoredFeeFloorWei(gasProfile, feePerDaGas, feePerL2Gas),
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
 *
 * SEMANTICS WHILE A BUNDLE IS PENDING — best-effort on timing, exact on
 * values (post-impl audit round 4, finding 1). The VALUES that land are
 * always byte-for-byte the confirmed digest (partial changes are refused
 * while pending, so nothing is filled from a live policy the activation
 * could swap). What CANNOT be guaranteed is the replace-in-time intent: if
 * this operation stalls past the revalidation's safety horizon (sleeping
 * machine, stalled prover) and the pending bundle activates before the
 * transaction lands, the pending bundle will have gone LIVE and this change
 * replaces it only ~12h after landing. There is no protocol-level
 * transaction expiry or contract predicate to close that (the contract is
 * frozen); instead the race is DETECTED after landing (deterministically
 * when the observation read succeeds; `'unknown'` when it fails — the
 * schedule itself has already succeeded either way) and reported via
 * `pendingActivatedFirst`, so the operator can react immediately rather
 * than discover it 12h later. Refusing all scheduling
 * while pending was considered and rejected: it would make a fat-fingered
 * pending policy un-cancelable — guaranteed 12h of exposure to trade
 * against a narrow stall race.
 */
export async function schedulePolicyChange(
  deps: PolicyDeps & {
    confirm: ConfirmAction;
    /** Merged into the send, exactly like deploy and claim do with theirs.
     * Dropping them silently made a configured fee-payment method not apply
     * to policy updates alone (round-9). */
    sendOptions?: Record<string, unknown>;
  },
  change: ScheduleChange,
  guards: ScheduleGuards,
  /** Extra abort condition checked with the CAS immediately before sending. */
  revalidateAlso?: () => Promise<string | undefined>,
): Promise<{
  scheduledRevision: bigint;
  /**
   * `true` when the previously-pending bundle is detected to have gone LIVE
   * (it activated before this schedule landed) — the confirmed
   * `replacesPending` intent was raced; this change now activates ~12h from
   * landing. `false` when nothing was pending, the replacement landed in
   * time, or the pending values were observationally identical to the live
   * ones (in which case the race has no effect). `'unknown'` when the
   * schedule itself SUCCEEDED (checkpointed) but the post-send observation
   * read failed — do NOT retry the schedule; re-read policy state to learn
   * the outcome.
   */
  pendingActivatedFirst: boolean | 'unknown';
}> {
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

  // While a bundle is PENDING, fill-from-live is refused outright (round-3
  // finding 3): the 600s revalidation horizon below narrows the activation
  // race but cannot ENFORCE it — nothing expires the transaction if proving
  // stalls or the operator's machine sleeps past the horizon. With every
  // field explicit, activation crossing mid-operation can no longer smuggle
  // in values the operator never saw: whatever lands is byte-for-byte the
  // confirmed digest. (Aztec transactions carry no protocol-level expiry an
  // operator account could use here, so refusal is the enforceable option.)
  if (state.scheduled.pending) {
    const missing = (['maxFeeWei', 'maxUses', 'maxUsers', 'allowedTargets'] as const).filter(
      (k) => requested[k] === undefined,
    );
    if (missing.length > 0) {
      throw new Error(
        `a scheduled change is still pending (activates at ${state.scheduled.activatesAt}); ` +
          `omitted fields (${missing.join(', ')}) would be filled from a live policy the pending ` +
          `activation may replace mid-operation. Specify every field explicitly, or wait for activation.`,
      );
    }
  }

  const next: PolicyValues & { allowedTargets: string[] } = {
    maxFeeWei: requested.maxFeeWei ?? state.live.maxFeeWei,
    maxUses: requested.maxUses ?? state.live.maxUses,
    maxUsers: requested.maxUsers ?? state.live.maxUsers,
    allowedTargets: requested.allowedTargets ?? [...state.live.allowedTargets],
  };

  // The contract's own field widths, checked here because a DIRECT library
  // caller never passed through the CLI's parsing: without this, `maxUses: 0`
  // is planned, digested, approved by a human, and only then reverts in Noir
  // (round-6 finding 5).
  if (next.maxFeeWei <= 0n || next.maxFeeWei > U128_MAX) {
    throw new Error(`maxFeeWei must be in [1, ${U128_MAX}], got ${next.maxFeeWei}`);
  }
  for (const [field, value] of [
    ['maxUses', next.maxUses],
    ['maxUsers', next.maxUsers],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0 || value > U32_MAX) {
      throw new Error(`${field} must be an integer in [1, ${U32_MAX}], got ${value}`);
    }
  }

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

  // Snapshot before the plan digests them, so a confirm callback cannot swap
  // the options between the digest and the send.
  // The EFFECTIVE options: built once, digested, and sent. Digesting the raw
  // snapshot advertised coverage of values this function then overrides — a
  // caller's `waitForStatus: FINALIZED` or `from` changed the digest without
  // changing what executes (round-11).
  const { wait: callerWait, ...callerRest } = snapshotOptions(deps.sendOptions ?? {});
  const callerWaitObj = callerWait && typeof callerWait === 'object' ? (callerWait as Record<string, unknown>) : {};
  // A FLOOR, not a fixed value: deploy and claim both honor a request for
  // MORE finality and refuse less, and forcing CHECKPOINTED here silently
  // downgraded an operator who asked for PROVEN (round-11). The order table is
  // duplicated from those two deliberately — hoisting it into action-plan.ts
  // would put a static @aztec import into a module claim deliberately loads
  // TxStatus lazily from, and the tarball probe asserts that laziness.
  const FINALITY_ORDER = [TxStatus.PROPOSED, TxStatus.CHECKPOINTED, TxStatus.PROVEN, TxStatus.FINALIZED];
  const requestedStatus = callerWaitObj.waitForStatus as (typeof FINALITY_ORDER)[number] | undefined;
  const waitForStatus =
    requestedStatus !== undefined &&
    FINALITY_ORDER.indexOf(requestedStatus) > FINALITY_ORDER.indexOf(TxStatus.CHECKPOINTED)
      ? requestedStatus
      : TxStatus.CHECKPOINTED;
  const effectiveSendOptions = {
    ...callerRest,
    // `from` is not caller-overridable (the contract gates on the admin), and
    // the caller's other wait knobs (timeout, poll interval) are honored:
    // replacing the whole wait object dropped a raised timeout for a slow
    // prover, so the send threw while the transaction landed and the operator
    // re-ran, replacing their own pending bundle and restarting the 12h delay.
    from: deps.from,
    wait: { ...callerWaitObj, waitForStatus, dontThrowOnRevert: false },
  };
  const expectedRevision = state.scheduled.revision;
  const plan = createActionPlan('schedule-policy-change', {
    l1ChainId: info.l1ChainId,
    rollupVersion: info.rollupVersion,
    fpc: deps.fpcAddress.toString(),
    // WHO acts: `from` is the signer and payer, and the contract gates this
    // call on the admin. It was the only command whose plan did not bind it,
    // so a config module resolving `from` differently between the dry run and
    // the --yes run produced the same digest (round-9 finding 3).
    from: deps.from.toString(),
    sendOptionsDigest: digestOptions(effectiveSendOptions),
    expectedRevision: expectedRevision.toString(),
    maxFeeWei: next.maxFeeWei.toString(),
    maxUses: next.maxUses,
    maxUsers: next.maxUsers,
    allowedTargets: next.allowedTargets.join(','),
    replacesPending: state.scheduled.pending,
    // The best-effort disclosure travels IN the confirmed plan: the human
    // approving a replacement approves this outcome too (round-4 finding 1).
    ...(state.scheduled.pending
      ? {
          ifPendingActivatesFirst:
            'if the operation stalls and the pending bundle activates before this lands, that bundle ' +
            'goes live and THESE EXACT values replace it ~12h after landing (reported via pendingActivatedFirst)',
        }
      : {}),
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
    // never chose. Checked with a SAFETY HORIZON, not equality (round-2
    // finding 5): this callback runs before proving and broadcast, which
    // take real time — a bundle activating during proving would slip past a
    // point-in-time check. The horizon must exceed worst-case proving +
    // inclusion latency; activation timing is known 12h ahead, so aborting
    // a few minutes early costs the operator nothing.
    const timeNow = BigInt(latestNow?.header?.globalVariables?.timestamp ?? 0);
    // Fail CLOSED on a malformed block response: a zero timestamp would
    // otherwise sail under every horizon comparison (round-3 finding 3).
    if (timeNow === 0n) {
      return 'could not read fresh chain time for the activation check; refusing on unverifiable state';
    }
    if (state.scheduled.pending && timeNow + ACTIVATION_SAFETY_HORIZON_SECONDS >= state.scheduled.activatesAt) {
      return (
        'the pending policy change activated mid-operation or activates within the ' +
        `${ACTIVATION_SAFETY_HORIZON_SECONDS}s safety horizon (proving/broadcast could straddle it); ` +
        'wait for activation, then re-read state and rebuild the change'
      );
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
    // CHECKPOINTED-or-better finality before declaring success (round-5
    // finding 1): the wallet default (PROPOSED at 5.0.1) can be reorged out
    // AFTER this function returned a revision — the operator would believe a
    // replacement exists that doesn't. Same floor the claim path enforces.
    .send(effectiveSendOptions)
    .then(({ receipt }) => {
      if (!receipt.isMined() || !receipt.hasExecutionSucceeded()) {
        throw new Error(
          `schedule_settings transaction ${receipt.txHash} did not execute successfully (status ${receipt.status})`,
        );
      }
    });

  // Post-send race DETECTION (round-4 finding 1): if a bundle was pending,
  // determine whether it went live before our schedule landed by comparing
  // the now-live policy to the observed pending values. Exact up to
  // observational equivalence — when the pending values equal the old live
  // ones, the crossing is undetectable AND consequence-free, so `false` is
  // the honest answer. The schedule has ALREADY SUCCEEDED at checkpointed
  // finality by this point, so an observation failure must not surface as a
  // thrown error (the operator would read it as "the schedule failed" and
  // retry, replacing their own bundle and restarting its 12h delay —
  // round-5 finding 2). It degrades to `'unknown'`, never to a throw.
  let pendingActivatedFirst: boolean | 'unknown' = false;
  if (state.scheduled.pending) {
    try {
      const after = await readPolicyState(deps, guards.gasProfile);
      const p = state.scheduled;
      const sameTargets =
        after.live.allowedTargets.length === p.allowedTargets.length &&
        after.live.allowedTargets.every((t, i) => t.toLowerCase() === p.allowedTargets[i].toLowerCase());
      const wasOldLive =
        p.values.maxFeeWei === state.live.maxFeeWei &&
        p.values.maxUses === state.live.maxUses &&
        p.values.maxUsers === state.live.maxUsers &&
        p.allowedTargets.length === state.live.allowedTargets.length &&
        p.allowedTargets.every((t, i) => t.toLowerCase() === state.live.allowedTargets[i].toLowerCase());
      pendingActivatedFirst =
        !wasOldLive &&
        after.live.maxFeeWei === p.values.maxFeeWei &&
        after.live.maxUses === p.values.maxUses &&
        after.live.maxUsers === p.values.maxUsers &&
        sameTargets;
    } catch {
      pendingActivatedFirst = 'unknown';
    }
  }

  return { scheduledRevision: expectedRevision + 1n, pendingActivatedFirst };
}

/**
 * "Cancels" a pending change by scheduling the CURRENT live values — there is
 * no unschedule primitive on a delayed mutable. The live values still take a
 * fresh 12h trip.
 *
 * BEST-EFFORT, like all scheduling against a pending bundle (round-4 finding
 * 1): the pre-send revalidation aborts when the pending change already
 * activated or activates within the safety horizon, which NARROWS but cannot
 * CLOSE the race — a stall between revalidation and landing can still let
 * the pending bundle activate first. When that happens the outcome is: the
 * unwanted bundle runs until this schedule's own 12h delay elapses, then the
 * captured live values take effect (a delayed restore, not a clean cancel).
 * `pendingActivatedFirst: true` in the result is the post-send signal that
 * this occurred (`'unknown'` when the observation read failed — the cancel
 * itself succeeded; re-read state instead of re-running it) — decide then
 * whether to keep the restore or schedule something else.
 */
export async function cancelPendingPolicyChange(
  deps: PolicyDeps & {
    confirm: ConfirmAction;
    /** Cancel is the UNDO for a fat-fingered bundle, so it must be able to pay
     * the same way a schedule can — it dropped these entirely (round-10). */
    sendOptions?: Record<string, unknown>;
  },
  guards: ScheduleGuards,
): Promise<{ scheduledRevision: bigint; pendingActivatedFirst: boolean | 'unknown' }> {
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
    // Race-narrowing guard (review finding #5): if the pending change
    // ACTIVATES between the read above and this revalidation, the CAS still
    // passes (activation does not bump the revision) — abort cleanly here.
    // Beyond this point the residual stall race is detected post-send, not
    // prevented (see the docstring).
    async () => {
      const stillPending = await readPolicyState(deps, guards.gasProfile);
      if (!stillPending.scheduled.pending) {
        return 'too late to cancel — the pending change already activated; scheduling now would ROLL BACK the live policy for 12h';
      }
      return undefined;
    },
  );
}
