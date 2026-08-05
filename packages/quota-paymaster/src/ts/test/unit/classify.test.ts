/**
 * The capability-bound failure classification. The classifiers are only
 * reachable through createSendOnceContext (whose client does not retry), so
 * these tests construct one against a placeholder URL — nothing is sent.
 */
import { describe, expect, test } from 'vitest';
import { createSendOnceContext } from '../../client/send-once.js';
import { QuotaUnavailableError } from '../../errors.js';

const ctx = createSendOnceContext('http://localhost:1');

describe('isProvablyPreBroadcast', () => {
  test('QuotaUnavailableError is always pre-broadcast (raised by our own pre-flight)', () => {
    const err = new QuotaUnavailableError('exhausted', 'out', false);
    expect(ctx.isProvablyPreBroadcast(err)).toBe(true);
  });

  test("the node's own admission rejection is pre-broadcast…", () => {
    expect(ctx.isProvablyPreBroadcast(new Error('Invalid tx: insufficient fee payer balance'))).toBe(true);
  });

  test('…EXCEPT a nullifier conflict, which never says which nullifier', () => {
    // May be someone else's seat race (safe) or this user's own action already
    // in flight (unsafe). The message cannot tell them apart, so it is NEVER
    // evidence that nothing was broadcast.
    expect(ctx.isProvablyPreBroadcast(new Error('Invalid tx: Existing nullifier'))).toBe(false);
  });

  test('paymaster refusals raised during proving are pre-broadcast', () => {
    for (const message of [
      'Gas settings exceed the sponsorship allowance',
      'No sponsorship seats available today',
      'Sponsorship seat no longer within capacity',
      'No sponsored transactions remaining',
      'Player account class is not sponsored',
      'Sponsored call targets a non-allowlisted contract',
      'Invalid expiration timestamp',
    ]) {
      expect(ctx.isProvablyPreBroadcast(new Error(message)), message).toBe(true);
    }
  });

  test('anything unrecognised is NOT assumed pre-broadcast', () => {
    expect(ctx.isProvablyPreBroadcast(new Error('socket hang up'))).toBe(false);
    expect(ctx.isProvablyPreBroadcast(new Error('timeout awaiting response'))).toBe(false);
    expect(ctx.isProvablyPreBroadcast(undefined)).toBe(false);
  });
});

describe('isRetryableBeforeBroadcast', () => {
  test('safe AND useful: only sync-flavored failures retry', () => {
    const retryable = new QuotaUnavailableError('sync-pending', 'syncing', true);
    const terminal = new QuotaUnavailableError('exhausted', 'out', false);
    expect(ctx.isRetryableBeforeBroadcast(retryable)).toBe(true);
    expect(ctx.isRetryableBeforeBroadcast(terminal)).toBe(false);
    expect(ctx.isRetryableBeforeBroadcast(new Error('Invalid expiration timestamp'))).toBe(true);
    expect(ctx.isRetryableBeforeBroadcast(new Error('No sponsored transactions remaining'))).toBe(false);
    // Not even classifiable as pre-broadcast, so certainly not retryable.
    expect(ctx.isRetryableBeforeBroadcast(new Error('socket hang up'))).toBe(false);
  });
});
