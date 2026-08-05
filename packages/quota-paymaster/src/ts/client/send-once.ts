/**
 * The non-retrying send path and the failure classification that is only sound
 * on top of it.
 *
 * The default node-client transport retries with backoff (1/2/3s). For most
 * reads a retry only changes latency; for a SEND it changes the meaning of the
 * answer: a rejection string can belong to attempt two while attempt one sits
 * accepted in the mempool — so "the node refused this" stops being evidence
 * that nothing was broadcast, and acting on it (say, self-paying a fallback)
 * can replay the user's action.
 *
 * The classifiers are therefore CAPABILITY-BOUND twice over (post-impl audit
 * finding #2): they are only reachable through {@link createSendOnceContext},
 * whose node client provably does not retry — AND they refuse to classify by
 * message string unless the error came out of THIS context's
 * {@link SendOnceContext.attemptSend}, which brands every error it rethrows.
 * An error minted anywhere else (a retrying client, a different context, a
 * hand-built Error with a matching message) classifies as NOT provably
 * pre-broadcast, which is the safe answer.
 *
 * HONEST LIMIT of the brand: attemptSend brands whatever its callback throws;
 * it cannot verify which transport the callback actually used, because a
 * wallet's transport is not observable from outside (JS offers no in-process
 * way to police it). A caller who routes a RETRYING client's send through
 * attemptSend defeats the classification for themselves — same as a caller
 * who ignores the classifiers entirely. The threat model here is preventing
 * ACCIDENTAL misuse (classifying a foreign error, the default-client retry
 * trap); it is not a defense against the process lying to itself. The send
 * pipeline must be built on {@link SendOnceContext.node} — that is the
 * documented contract, mechanically checkable only by the caller.
 */
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { makeFetch } from '@aztec/foundation/json-rpc/client';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';
import { isQuotaUnavailableError } from '../errors.js';

/**
 * Message-level allow-list of failures that cannot have left a transaction in
 * flight. Only meaningful for BRANDED errors — the caller-facing classifier
 * checks the brand first.
 *
 * The dangerous case is a send that reached the sequencer while the response
 * was lost: rebuilding then replays the user's action under a new nonce. So
 * this allow-lists the reasons known to arise BEFORE broadcast — the paymaster
 * refusing to sponsor, and the allowance still syncing — rather than trying to
 * enumerate everything unsafe.
 */
function messageIsPreBroadcast(message: string): boolean {
  // `Invalid tx: …` is the node's own rejection, raised by `isValidTx` BEFORE
  // the transaction reaches the pool — so it proves the transaction was never
  // admitted. Only sound because this context's client does not retry.
  if (/Invalid tx:/i.test(message)) {
    // …except a nullifier conflict, which reports only "some nullifier
    // exists", never which one. It may be someone else taking the same seat
    // (safe) or this user's own action already in flight — from a reload, a
    // second device, or another executor instance (not safe). A local send
    // queue cannot rule any of that out; treating the conflict as
    // pre-broadcast evidence could replay the action. The source project
    // briefly allowed it under a "single executor, maxConcurrency 1"
    // argument; review rejected that as too local. Keep it excluded.
    return !/Existing nullifier/i.test(message);
  }

  return (
    /Gas settings exceed the sponsorship allowance/i.test(message) ||
    /Invalid expiration timestamp/i.test(message) ||
    /No sponsorship seats available/i.test(message) ||
    /seat no longer within capacity/i.test(message) ||
    /No sponsored transactions remaining/i.test(message) ||
    /account class is not sponsored/i.test(message) ||
    /non-allowlisted contract/i.test(message)
  );
}

export interface SendOnceContext {
  /** A node client whose transport NEVER retries. Use it for sends. */
  node: AztecNode;
  /**
   * Runs one whole send attempt (simulate + prove + broadcast, built on THIS
   * context's node) and brands any error it throws. The classifiers only
   * answer by message string for errors branded here — everything else is
   * "not provably pre-broadcast".
   */
  attemptSend<T>(attempt: () => Promise<T>): Promise<T>;
  /**
   * True only for failures that cannot have left a transaction in flight.
   * Only valid for errors from this context's `attemptSend` (or the SDK's own
   * QuotaUnavailableError, raised by pre-flight before anything is built).
   */
  isProvablyPreBroadcast(err: unknown): boolean;
  /** Safe AND useful to retry. Same validity caveat. */
  isRetryableBeforeBroadcast(err: unknown): boolean;
}

/**
 * Builds the non-retrying send path plus its classifiers. Sponsored sends MUST
 * run inside `attemptSend`, over this context's node client, for the
 * classifiers' answers to mean anything.
 */
export function createSendOnceContext(nodeUrl: string): SendOnceContext {
  const node = createAztecNodeClient(nodeUrl, {}, makeFetch([], false));
  /** Errors this context's own send path threw — the classifiers' evidence. */
  const branded = new WeakSet<object>();

  const isProvablyPreBroadcast = (err: unknown): boolean => {
    if (isQuotaUnavailableError(err)) {
      // Raised by the SDK's own pre-flight, before anything is built or sent —
      // pre-broadcast by construction, no brand needed.
      return true;
    }
    // Message strings are only evidence when the error came from THIS
    // context's non-retrying send path. A foreign error with the same message
    // may belong to attempt two of a retrying transport (finding #2).
    if (typeof err !== 'object' || err === null || !branded.has(err)) {
      return false;
    }
    return messageIsPreBroadcast(String((err as { message?: string }).message ?? err));
  };

  const isRetryableBeforeBroadcast = (err: unknown): boolean => {
    if (!isProvablyPreBroadcast(err)) return false;
    if (isQuotaUnavailableError(err)) {
      return Boolean((err as { retryable?: boolean }).retryable);
    }
    return /Invalid expiration timestamp/i.test(String((err as { message?: string })?.message ?? err ?? ''));
  };

  return {
    node,
    async attemptSend<T>(attempt: () => Promise<T>): Promise<T> {
      try {
        return await attempt();
      } catch (err) {
        if (typeof err === 'object' && err !== null) branded.add(err);
        throw err;
      }
    },
    isProvablyPreBroadcast,
    isRetryableBeforeBroadcast,
  };
}
