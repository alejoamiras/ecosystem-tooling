/**
 * Why a sponsored transaction could not be sent.
 *
 * The distinction that matters most is SyncPending vs Exhausted. They look
 * identical from a naive "is the allowance note there?" check — a wallet that
 * has not yet discovered the note is indistinguishable from one with nothing
 * left — but they call for opposite responses: wait a moment, versus tell the
 * user they are out for today. Guessing wrong sends active players to a funding
 * page they do not need, so exhaustion is only ever declared on positive
 * evidence.
 */
export type QuotaUnavailableReason =
  /** Allowance state not yet observable (wallet still syncing). Retry shortly. */
  | 'sync-pending'
  /** Confirmed: this user has used their whole allowance for this generation. */
  | 'exhausted'
  /** Every seat for this generation is taken; capacity frees at the reset. */
  | 'no-seats'
  /** Network fees currently exceed the paymaster's per-transaction ceiling. */
  | 'fee-spike'
  /** The paymaster's own balance is too low to sponsor anything. */
  | 'paymaster-empty'
  /** The chosen generation is no longer accepted (clock rolled over). */
  | 'rollover'
  /** This call targets a contract the paymaster does not sponsor. */
  | 'not-sponsored'
  /** Sponsorship was narrowed and this user's seat fell outside the new cap. */
  | 'seat-revoked';

/**
 * Instances constructed by THIS module — populated in the constructor, so a
 * hand-built `{ name: 'QuotaUnavailableError' }` (or an Error renamed to
 * match) never passes {@link isQuotaUnavailableError}. A WeakSet rather than
 * `instanceof` because bundlers can duplicate the module, and rather than a
 * name check because names are forgeable (post-impl audit round 2, finding 1).
 */
const constructedHere = new WeakSet<object>();

export class QuotaUnavailableError extends Error {
  constructor(
    readonly reason: QuotaUnavailableReason,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'QuotaUnavailableError';
    constructedHere.add(this);
  }
}

/** True only for errors actually constructed via {@link QuotaUnavailableError}. */
export function isQuotaUnavailableError(err: unknown): err is QuotaUnavailableError {
  return typeof err === 'object' && err !== null && constructedHere.has(err);
}

/** Maps a contract revert message to a reason, or undefined if unrecognised. */
export function reasonFromRevert(message: string): QuotaUnavailableReason | undefined {
  if (/No sponsored transactions remaining/i.test(message)) return 'exhausted';
  if (/No sponsorship seats available/i.test(message)) return 'no-seats';
  // Not the same as "seats are full": the operator lowered the user cap and
  // this user was above it. Telling them the day is full would be untrue.
  if (/seat no longer within capacity/i.test(message)) return 'seat-revoked';
  if (/Gas settings exceed the sponsorship allowance/i.test(message)) return 'fee-spike';
  if (/Generation is not currently sponsorable/i.test(message)) return 'rollover';
  if (/non-allowlisted contract/i.test(message)) return 'not-sponsored';
  // The user's ACCOUNT class isn't allowlisted (only true when the wallet's
  // account version drifted from the paymaster's config). Same user outcome as
  // an unsponsored target: fall back to their own gas.
  if (/account class is not sponsored/i.test(message)) return 'not-sponsored';
  return undefined;
}
