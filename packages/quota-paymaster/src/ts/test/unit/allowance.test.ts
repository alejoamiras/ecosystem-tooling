/**
 * Fee-source resolution and the sync-await discipline.
 *
 * These tests encode the rule that cost the most to get right: a wallet that has
 * not yet discovered its allowance note must never be reported as "out of free
 * transactions", because that sends an active user to a funding page they do
 * not need. The syncing trade-off (wait vs self-pay) is an EXPLICIT caller
 * policy — the source project's code and comment disagreed on it.
 */
import { describe, expect, test } from 'vitest';
import {
  type AllowanceState,
  awaitAllowanceTransition,
  type FeeSourceInputs,
  resolveFeeSource,
} from '../../allowance.js';
import { generationAt, SECONDS_PER_DAY } from '../../generation.js';

const NOW = 1_785_067_200n; // mid-day
const GENERATION = generationAt(NOW);

function inputs(overrides: Partial<FeeSourceInputs> = {}): FeeSourceInputs {
  const state: AllowanceState = {
    generation: GENERATION,
    subscribed: true,
    remaining: 5,
    syncing: false,
    ...(overrides.state ?? {}),
  };
  return {
    chainTimestampSeconds: NOW,
    onSyncing: 'wait',
    findFreeSeat: async () => 3,
    ownBalance: 0n,
    minSelfPayBalance: 5n * 10n ** 18n,
    paymasterBalance: 10n ** 21n,
    minPaymasterBalance: 10n ** 16n,
    ...overrides,
    state,
  };
}

describe('resolveFeeSource', () => {
  test('uses sponsorship when allowance remains', async () => {
    const source = await resolveFeeSource(inputs());
    expect(source).toEqual({ kind: 'sponsored', generation: GENERATION });
  });

  test('claims a seat on the first transaction of the day', async () => {
    const source = await resolveFeeSource(
      inputs({
        state: { generation: GENERATION, subscribed: false, remaining: 0, syncing: false },
      }),
    );
    expect(source).toEqual({ kind: 'sponsored-first', generation: GENERATION, seat: 3 });
  });

  test('exhausted with no funds is blocked, with funds falls back to self-pay', async () => {
    const exhausted = {
      generation: GENERATION,
      subscribed: true,
      remaining: 0,
      syncing: false,
    };

    expect(await resolveFeeSource(inputs({ state: exhausted }))).toEqual({
      kind: 'blocked',
      reason: 'exhausted',
    });

    expect(await resolveFeeSource(inputs({ state: exhausted, ownBalance: 10n ** 19n }))).toEqual({
      kind: 'self',
    });
  });

  test('a syncing allowance is NEVER reported as exhausted', async () => {
    const syncing = {
      generation: GENERATION,
      subscribed: false,
      remaining: 0,
      syncing: true,
    };
    const source = await resolveFeeSource(inputs({ state: syncing }));
    expect(source).toEqual({ kind: 'blocked', reason: 'sync-pending' });
    // The distinction that matters: retryable, not a dead end.
    expect(source).not.toEqual({ kind: 'blocked', reason: 'exhausted' });
  });

  test("onSyncing 'wait' never spends the user's balance on inconclusive evidence", async () => {
    const syncing = {
      generation: GENERATION,
      subscribed: false,
      remaining: 0,
      syncing: true,
    };
    // Even with plenty of funds: 'wait' means wait.
    const source = await resolveFeeSource(inputs({ state: syncing, onSyncing: 'wait', ownBalance: 10n ** 20n }));
    expect(source).toEqual({ kind: 'blocked', reason: 'sync-pending' });
  });

  test("'wait' holds even when the syncing state ALSO carries a stale generation", async () => {
    // The midnight-while-syncing probe (post-impl audit finding #3): before
    // the fix, the stale-generation branch ran first and self-paid a funded
    // user despite the explicit 'wait'.
    const syncingAndStale = {
      generation: GENERATION,
      subscribed: false,
      remaining: 0,
      syncing: true,
    };
    const source = await resolveFeeSource(
      inputs({
        state: syncingAndStale,
        chainTimestampSeconds: NOW + SECONDS_PER_DAY, // past midnight: generation is stale
        onSyncing: 'wait',
        ownBalance: 10n ** 20n, // funded — the tempting-but-wrong self-pay
      }),
    );
    expect(source).toEqual({ kind: 'blocked', reason: 'sync-pending' });
  });

  test("onSyncing 'self-pay' charges a funded user while syncing, but never an unfunded one", async () => {
    const syncing = {
      generation: GENERATION,
      subscribed: false,
      remaining: 0,
      syncing: true,
    };
    expect(await resolveFeeSource(inputs({ state: syncing, onSyncing: 'self-pay', ownBalance: 10n ** 20n }))).toEqual({
      kind: 'self',
    });
    // No funds: still blocked as sync-pending, never exhausted.
    expect(await resolveFeeSource(inputs({ state: syncing, onSyncing: 'self-pay', ownBalance: 0n }))).toEqual({
      kind: 'blocked',
      reason: 'sync-pending',
    });
  });

  test('a full day blocks with no-seats rather than claiming an invalid seat', async () => {
    const source = await resolveFeeSource(
      inputs({
        state: { generation: GENERATION, subscribed: false, remaining: 0, syncing: false },
        findFreeSeat: async () => null,
      }),
    );
    expect(source).toEqual({ kind: 'blocked', reason: 'no-seats' });
  });

  test('a generation held past midnight is caught as rollover, not attempted', async () => {
    const source = await resolveFeeSource(inputs({ chainTimestampSeconds: NOW + SECONDS_PER_DAY }));
    expect(source).toEqual({ kind: 'blocked', reason: 'rollover' });
  });

  test('an empty paymaster degrades to self-pay instead of failing to prove', async () => {
    const source = await resolveFeeSource(inputs({ paymasterBalance: 0n, ownBalance: 10n ** 19n }));
    expect(source).toEqual({ kind: 'self' });
  });
});

describe('awaitAllowanceTransition', () => {
  test('returns as soon as the expected count appears, echoing the generation', async () => {
    let calls = 0;
    const result = await awaitAllowanceTransition({
      generation: GENERATION,
      readState: async () => {
        calls += 1;
        return calls < 3 ? { subscribed: false, remaining: 0 } : { subscribed: true, remaining: 4 };
      },
      expectedRemaining: 4,
      sleep: async () => {},
    });
    expect(result.syncing).toBe(false);
    expect(result.remaining).toBe(4);
    // The returned state carries the REAL generation (the source project
    // hardcoded 0 here — a dead field its review flagged).
    expect(result.generation).toBe(GENERATION);
  });

  test('treats the note disappearing as the expected end of the allowance (with prior evidence)', async () => {
    let reads = 0;
    const result = await awaitAllowanceTransition({
      generation: GENERATION,
      readState: async () => {
        reads += 1;
        return { subscribed: false, remaining: 0 };
      },
      expectedRemaining: 0,
      // The caller SAW the note (the send that spent the last use was built
      // from it) — that positive evidence is what licenses the conclusion.
      observedSubscribedBefore: true,
      sleep: async () => {},
    });
    // Absence is the signal here, not a timeout — but it takes TWO consecutive
    // absent reads: a single one is also what a not-yet-synced wallet returns
    // (post-impl audit finding #3b).
    expect(result.syncing).toBe(false);
    expect(reads).toBe(2);
    // Exhausted-by-consumption keeps subscribed: the seat is still held this
    // generation; reporting false would trigger a doomed second seat claim
    // (round-2 finding 2).
    expect(result.subscribed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  test('absence WITHOUT prior positive evidence can only time out as syncing, never conclude', async () => {
    // A lagging wallet returns "absent" forever — indistinguishable from
    // exhaustion by absence alone (round-2 finding 2).
    let clock = 0;
    const result = await awaitAllowanceTransition({
      generation: GENERATION,
      readState: async () => ({ subscribed: false, remaining: 0 }),
      expectedRemaining: 0,
      timeoutMs: 1_000,
      now: () => {
        clock += 200;
        return clock;
      },
      sleep: async () => {},
    });
    expect(result.syncing).toBe(true);
  });

  test('a single absent read does NOT conclude exhaustion when the note reappears', async () => {
    let calls = 0;
    const result = await awaitAllowanceTransition({
      generation: GENERATION,
      // absent → present → absent → absent: the early lone absence (a wallet
      // mid-sync) must not end the wait; only the later consecutive pair does.
      // The in-wait presence read supplies the positive evidence.
      readState: async () => {
        calls += 1;
        return calls === 2 ? { subscribed: true, remaining: 1 } : { subscribed: false, remaining: 0 };
      },
      expectedRemaining: 0,
      sleep: async () => {},
    });
    expect(result.syncing).toBe(false);
    expect(result.subscribed).toBe(true);
    expect(calls).toBe(4); // absent(1) + present(reset) + absent(1) + absent(2)
  });

  test('a timeout reports syncing rather than inventing an answer', async () => {
    let clock = 0;
    const result = await awaitAllowanceTransition({
      generation: GENERATION,
      readState: async () => ({ subscribed: false, remaining: 0 }),
      expectedRemaining: 4,
      timeoutMs: 1_000,
      now: () => {
        clock += 400;
        return clock;
      },
      sleep: async () => {},
    });
    expect(result.syncing).toBe(true);
  });
});
