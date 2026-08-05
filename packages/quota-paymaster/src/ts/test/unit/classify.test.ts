/**
 * The capability-bound failure classification. The classifiers are only
 * reachable through createSendOnceContext (whose client does not retry), and
 * message-string classification only answers for errors BRANDED by that
 * context's own attemptSend — these tests construct a context against a
 * placeholder URL (nothing is sent) and brand errors by throwing them through
 * attemptSend.
 */
import { describe, expect, test } from 'vitest';
import { createSendOnceContext } from '../../client/send-once.js';
import { QuotaUnavailableError } from '../../errors.js';

const ctx = createSendOnceContext('http://localhost:1');

/** Throws `err` through the context's send boundary so it carries the brand. */
async function branded(err: Error): Promise<Error> {
  try {
    await ctx.attemptSend(() => Promise.reject(err));
  } catch {
    /* the throw is the point */
  }
  return err;
}

describe('isProvablyPreBroadcast', () => {
  test('QuotaUnavailableError is always pre-broadcast (raised by our own pre-flight)', () => {
    const err = new QuotaUnavailableError('exhausted', 'out', false);
    expect(ctx.isProvablyPreBroadcast(err)).toBe(true);
  });

  test("the node's own admission rejection is pre-broadcast…", async () => {
    expect(ctx.isProvablyPreBroadcast(await branded(new Error('Invalid tx: insufficient fee payer balance')))).toBe(
      true,
    );
  });

  test('…EXCEPT a nullifier conflict, which never says which nullifier', async () => {
    // May be someone else's seat race (safe) or this user's own action already
    // in flight (unsafe). The message cannot tell them apart, so it is NEVER
    // evidence that nothing was broadcast.
    expect(ctx.isProvablyPreBroadcast(await branded(new Error('Invalid tx: Existing nullifier')))).toBe(false);
  });

  test('paymaster refusals raised during proving are pre-broadcast', async () => {
    for (const message of [
      'Gas settings exceed the sponsorship allowance',
      'No sponsorship seats available today',
      'Sponsorship seat no longer within capacity',
      'No sponsored transactions remaining',
      'Player account class is not sponsored',
      'Sponsored call targets a non-allowlisted contract',
      'Invalid expiration timestamp',
    ]) {
      expect(ctx.isProvablyPreBroadcast(await branded(new Error(message))), message).toBe(true);
    }
  });

  test('a FOREIGN error is never pre-broadcast, even with a matching message', async () => {
    // The unsafe case the brand exists for (post-impl audit finding #2): an
    // error from a RETRYING client carries the same strings, but "the node
    // refused this" may describe attempt two while attempt one sits accepted
    // in the mempool. Unbranded ⇒ not evidence.
    expect(ctx.isProvablyPreBroadcast(new Error('Invalid tx: insufficient fee payer balance'))).toBe(false);
    expect(ctx.isProvablyPreBroadcast(new Error('No sponsored transactions remaining'))).toBe(false);
    // A brand from ANOTHER context does not transfer either.
    const other = createSendOnceContext('http://localhost:2');
    const err = new Error('No sponsored transactions remaining');
    try {
      await other.attemptSend(() => Promise.reject(err));
    } catch {
      /* branded by `other`, not `ctx` */
    }
    expect(ctx.isProvablyPreBroadcast(err)).toBe(false);
    expect(other.isProvablyPreBroadcast(err)).toBe(true);
  });

  test('anything unrecognised is NOT assumed pre-broadcast, branded or not', async () => {
    expect(ctx.isProvablyPreBroadcast(await branded(new Error('socket hang up')))).toBe(false);
    expect(ctx.isProvablyPreBroadcast(await branded(new Error('timeout awaiting response')))).toBe(false);
    expect(ctx.isProvablyPreBroadcast(undefined)).toBe(false);
  });

  test('attemptSend returns the value when the attempt succeeds', async () => {
    expect(await ctx.attemptSend(() => Promise.resolve(42))).toBe(42);
  });
});

describe('isRetryableBeforeBroadcast', () => {
  test('safe AND useful: only sync-flavored failures retry', async () => {
    const retryable = new QuotaUnavailableError('sync-pending', 'syncing', true);
    const terminal = new QuotaUnavailableError('exhausted', 'out', false);
    expect(ctx.isRetryableBeforeBroadcast(retryable)).toBe(true);
    expect(ctx.isRetryableBeforeBroadcast(terminal)).toBe(false);
    expect(ctx.isRetryableBeforeBroadcast(await branded(new Error('Invalid expiration timestamp')))).toBe(true);
    expect(ctx.isRetryableBeforeBroadcast(await branded(new Error('No sponsored transactions remaining')))).toBe(false);
    // Not even classifiable as pre-broadcast, so certainly not retryable.
    expect(ctx.isRetryableBeforeBroadcast(await branded(new Error('socket hang up')))).toBe(false);
    // Unbranded: the message alone is not evidence.
    expect(ctx.isRetryableBeforeBroadcast(new Error('Invalid expiration timestamp'))).toBe(false);
  });
});
