/**
 * Allowance state and fee-source resolution.
 *
 * This is the module that decides, per transaction, who pays: the paymaster,
 * the user's own balance, or nobody (send them to the bridge). It also owns the
 * sync-await discipline, which exists because "the wallet hasn't found the note
 * yet" and "the user is out of transactions" look identical unless you insist on
 * positive evidence before declaring the latter.
 */
import { QuotaUnavailableError, type QuotaUnavailableReason } from './errors.js';
import { isGenerationStale } from './generation.js';

export interface AllowanceState {
  generation: number;
  /** True once the user has claimed a seat this generation. */
  subscribed: boolean;
  /** Transactions left today. Meaningful only when `subscribed`. */
  remaining: number;
  /** True while evidence is still inconclusive — never treat as exhausted. */
  syncing: boolean;
}

export type FeeSource =
  /** The paymaster pays; first transaction of the day, so a seat is claimed. */
  | { kind: 'sponsored-first'; generation: number; seat: number }
  /** The paymaster pays against an existing allowance. */
  | { kind: 'sponsored'; generation: number }
  /** No sponsorship available, but the user can pay for themselves. */
  | { kind: 'self' }
  /** Nobody can pay: the caller should surface funding options. */
  | { kind: 'blocked'; reason: QuotaUnavailableReason };

/**
 * What happens while allowance evidence is still inconclusive (syncing).
 *
 * REQUIRED, with no default, because the two choices charge different people:
 *  - 'wait':     never spend the user's balance on inconclusive evidence; the
 *                caller receives `blocked: sync-pending` (retryable) and
 *                decides how to wait. The safe posture for a generic SDK.
 *  - 'self-pay': a user who CAN pay is charged their own balance rather than
 *                being made to wait. This silently charges users who still
 *                have free transactions; choose it only when a product
 *                decision says waiting is worse (the Dark Forest client does).
 */
export type OnSyncingPolicy = 'wait' | 'self-pay';

/** What the caller must provide for a decision. Deliberately all injectable. */
export interface FeeSourceInputs {
  state: AllowanceState;
  chainTimestampSeconds: bigint;
  /** See {@link OnSyncingPolicy}. Required — the trade-off must be explicit. */
  onSyncing: OnSyncingPolicy;
  /** Free seat for a first-of-day transaction, or null when the day is full. */
  findFreeSeat: () => Promise<number | null>;
  /** The user's own fee-juice balance. */
  ownBalance: bigint;
  /** Minimum own balance considered enough to self-pay. */
  minSelfPayBalance: bigint;
  /** Paymaster balance, so an empty one degrades gracefully. */
  paymasterBalance: bigint;
  /** Below this the paymaster is treated as unable to sponsor. */
  minPaymasterBalance: bigint;
}

/**
 * Picks who pays, in strict preference order: sponsorship, then the user's own
 * balance, then blocked. Falling back to self-payment on CONCLUSIVE evidence is
 * deliberate — a user with funds should never be stopped just because
 * sponsorship lapsed. On INCONCLUSIVE evidence (`syncing`), behavior follows
 * the caller's explicit {@link OnSyncingPolicy}.
 */
export async function resolveFeeSource(inputs: FeeSourceInputs): Promise<FeeSource> {
  const { state, chainTimestampSeconds } = inputs;

  const canSelfPay = inputs.ownBalance >= inputs.minSelfPayBalance;
  const fallback = (reason: QuotaUnavailableReason): FeeSource =>
    canSelfPay ? { kind: 'self' } : { kind: 'blocked', reason };

  // Inconclusive evidence is judged FIRST — before staleness or any other
  // fallback path. Every other branch may auto-charge a funded user, and
  // under `onSyncing: 'wait'` a syncing state must NEVER do that, not even
  // when its generation is also stale (a midnight crossing while the wallet
  // syncs hit exactly this: the stale-generation fallback self-paid despite
  // the explicit 'wait'; post-impl audit finding #3).
  if (state.syncing) {
    if (inputs.onSyncing === 'self-pay' && canSelfPay) {
      return { kind: 'self' };
    }
    return { kind: 'blocked', reason: 'sync-pending' };
  }

  // A generation chosen before midnight is no longer accepted after it; the
  // caller must re-read chain time rather than prove something doomed to fail.
  if (isGenerationStale(state.generation, chainTimestampSeconds)) {
    return fallback('rollover');
  }

  if (inputs.paymasterBalance < inputs.minPaymasterBalance) {
    return fallback('paymaster-empty');
  }

  if (state.subscribed) {
    return state.remaining > 0 ? { kind: 'sponsored', generation: state.generation } : fallback('exhausted');
  }

  const seat = await inputs.findFreeSeat();
  if (seat === null) {
    return fallback('no-seats');
  }
  return { kind: 'sponsored-first', generation: state.generation, seat };
}

/**
 * Waits for the allowance to reach the state a just-sent transaction implies.
 *
 * Polls for a *specific expected transition* rather than "any change", because
 * the terminal case — the note vanishing when the last transaction is used — is
 * indistinguishable from "not synced yet" under a looser check.
 *
 * Returns the observed state; `syncing: true` means the wait timed out and the
 * caller must keep treating the allowance as unknown.
 */
export async function awaitAllowanceTransition(options: {
  /** The generation being observed; echoed back in the returned state. */
  generation: number;
  readState: () => Promise<{ subscribed: boolean; remaining: number }>;
  /** Expected remaining count, or 0 meaning "the allowance should be used up". */
  expectedRemaining: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AllowanceState & { observedAfterMs: number }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const startedAt = now();
  let last = { subscribed: false, remaining: 0 };
  let absentStreak = 0;

  while (now() - startedAt < timeoutMs) {
    last = await options.readState();
    // Exhaustion needs the note gone on TWO consecutive reads: a single
    // absent read is also what a not-yet-synced wallet returns, and
    // concluding from it could send the caller into a doomed re-subscribe
    // (post-impl audit finding #3b).
    absentStreak = last.subscribed ? 0 : absentStreak + 1;
    const reached =
      options.expectedRemaining > 0
        ? last.subscribed && last.remaining === options.expectedRemaining
        : absentStreak >= 2; // exhausted: the note is CONSISTENTLY gone
    if (reached) {
      return {
        generation: options.generation,
        subscribed: last.subscribed,
        remaining: last.remaining,
        syncing: false,
        observedAfterMs: now() - startedAt,
      };
    }
    await sleep(pollIntervalMs);
  }

  return {
    generation: options.generation,
    subscribed: last.subscribed,
    remaining: last.remaining,
    syncing: true,
    observedAfterMs: now() - startedAt,
  };
}

/** Raises the typed error a blocked decision implies. */
export function assertNotBlocked(source: FeeSource): void {
  if (source.kind === 'blocked') {
    throw new QuotaUnavailableError(
      source.reason,
      `Cannot pay for this transaction: ${source.reason}`,
      source.reason === 'sync-pending' || source.reason === 'rollover',
    );
  }
}
