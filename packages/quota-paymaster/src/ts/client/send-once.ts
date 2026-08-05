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
 * The classifiers are therefore CAPABILITY-BOUND: they are only reachable
 * through {@link createSendOnceContext}, whose node client provably does not
 * retry. There is no standalone export to misapply to a retrying transport.
 */
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { makeFetch } from '@aztec/foundation/json-rpc/client';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';

/**
 * True only for failures that cannot have left a transaction in flight.
 *
 * The dangerous case is a send that reached the sequencer while the response
 * was lost: rebuilding then replays the user's action under a new nonce. So
 * this allow-lists the reasons known to arise BEFORE broadcast — the paymaster
 * refusing to sponsor, and the allowance still syncing — rather than trying to
 * enumerate everything unsafe.
 */
function isProvablyPreBroadcast(err: unknown): boolean {
  if ((err as { name?: string })?.name === 'QuotaUnavailableError') {
    // Raised by the SDK's own pre-flight, before anything is built or sent.
    return true;
  }
  const message = String((err as { message?: string })?.message ?? err ?? '');
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

/**
 * Whether re-attempting is both SAFE and USEFUL.
 *
 * Safety is `isProvablyPreBroadcast` — anything else may already be in flight,
 * and rebuilding would replay the user's action. Usefulness is narrower still:
 * only a wallet that was mid-sync (or a stale expiration) has any prospect of
 * succeeding the second time.
 */
function isRetryableBeforeBroadcast(err: unknown): boolean {
  if (!isProvablyPreBroadcast(err)) return false;
  if ((err as { name?: string })?.name === 'QuotaUnavailableError') {
    return Boolean((err as { retryable?: boolean }).retryable);
  }
  return /Invalid expiration timestamp/i.test(String((err as { message?: string })?.message ?? err ?? ''));
}

export interface SendOnceContext {
  /** A node client whose transport NEVER retries. Use it for sends. */
  node: AztecNode;
  /** See module doc. Only valid for errors raised through this context's node. */
  isProvablyPreBroadcast(err: unknown): boolean;
  /** Safe AND useful to retry. Same validity caveat. */
  isRetryableBeforeBroadcast(err: unknown): boolean;
}

/**
 * Builds the non-retrying send path plus its classifiers. Sponsored sends MUST
 * go through this node client for the classifiers' answers to mean anything.
 */
export function createSendOnceContext(nodeUrl: string): SendOnceContext {
  const node = createAztecNodeClient(nodeUrl, {}, makeFetch([], false));
  return { node, isProvablyPreBroadcast, isRetryableBeforeBroadcast };
}
