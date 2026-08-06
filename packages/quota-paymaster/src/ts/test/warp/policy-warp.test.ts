/**
 * The time-travel suite: policy activation across the 12h delay, clamps and
 * raises under a live policy, seat eviction, and the UTC-midnight crossing
 * (mandatory gap-closer). Every test here warps the chain — which is global
 * and irreversible — so this file runs ONLY on the disposable network the
 * globalSetup provisions, and each policy test deploys its own paymaster.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { FpcTestTargetContract } from '../../../artifacts/FpcTestTarget.js';
import type { QuotaFpcContract } from '../../../artifacts/QuotaFpc.js';
import { generationAt } from '../../generation.js';
import { buildSandwichPayload } from '../../sandwich.js';
import {
  type Ctx,
  chainTimestamp,
  connect,
  evidence,
  fundWithFeeJuice,
  sendFromPaymaster,
  warpChainBy,
  warpChainToDayStart,
} from '../harness.js';
import {
  allowanceOf,
  bundleFrom,
  callsOf,
  currentRevision,
  deployOwnFpc,
  MAX_USERS,
  MAX_USES,
  unwrap,
} from '../suite-helpers.js';

const DAY = 86_400;
const GRACE = 600;
const ACTIVATION = 43_260; // 12h + a minute

describe('QuotaFpc time-travel', () => {
  let ctx: Ctx;
  let target: FpcTestTargetContract;
  let player: import('@aztec/stdlib/aztec-address').AztecAddress;
  let other: import('@aztec/stdlib/aztec-address').AztecAddress;

  const poke = () => target.methods.ping().send({ from: player });
  const recordCall = () => callsOf(target.methods.record());

  async function fund(fpc: QuotaFpcContract) {
    await fundWithFeeJuice(ctx.node, ctx.wallet, fpc.address, 10n ** 21n, player, poke);
  }

  async function sponsorOn(
    fpc: QuotaFpcContract,
    from: import('@aztec/stdlib/aztec-address').AztecAddress,
    opts: { seat?: number; generation: number },
  ) {
    const payload = await buildSandwichPayload(
      {
        calls: await recordCall(),
        player: from,
        fpcAddress: fpc.address,
        generation: opts.generation,
        seat: opts.seat,
      },
      ctx.wallet,
      // biome-ignore lint/suspicious/noExplicitAny: structural QuotaFpcMethods
      fpc as any,
    );
    return sendFromPaymaster(ctx, payload, from);
  }

  beforeAll(async () => {
    ctx = await connect();
    player = ctx.addresses[0];
    other = ctx.addresses[1];
    const targetDeploy = FpcTestTargetContract.deploy(ctx.wallet);
    await targetDeploy.send({ from: player });
    target = await targetDeploy.register();
  });

  /**
   * MANDATORY gap-closer (handoff §6): a real sponsored flow ACROSS a UTC
   * midnight. Inside the closing grace window tomorrow's generation is already
   * subscribable; after midnight it keeps spending; and yesterday's generation
   * dies the moment the day rolls.
   */
  test('a subscription taken in the grace window survives midnight; the old day dies', async () => {
    const own = await deployOwnFpc(ctx, target, player);
    await fund(own);

    // Deterministic footing: start a fresh day, then walk to the grace window.
    await warpChainToDayStart(ctx.node, poke);
    const dayStart = await chainTimestamp(ctx.node);
    const today = generationAt(dayStart);
    await warpChainBy(ctx.node, DAY - GRACE / 2 - Number(dayStart % BigInt(DAY)), poke);
    const inGrace = await chainTimestamp(ctx.node);
    expect(Number(inGrace % BigInt(DAY))).toBeGreaterThanOrEqual(DAY - GRACE);
    evidence('midnight/in-grace', { secondsIntoDay: Number(inGrace % BigInt(DAY)), today });

    // Subscribe TOMORROW's generation from inside the grace window.
    await sponsorOn(own, player, { seat: 0, generation: today + 1 });
    expect(await allowanceOf(own, player, today + 1)).toEqual({
      subscribed: true,
      remaining: MAX_USES - 1,
    });

    // Cross midnight.
    await warpChainBy(ctx.node, GRACE, poke);
    const afterMidnight = await chainTimestamp(ctx.node);
    expect(generationAt(afterMidnight)).toBe(today + 1);

    // The grace-window subscription keeps spending in its own day…
    await sponsorOn(own, player, { generation: today + 1 });
    expect((await allowanceOf(own, player, today + 1)).remaining).toBe(MAX_USES - 2);

    // …and the PREVIOUS generation is no longer sponsorable at all.
    await expect(sponsorOn(own, other, { seat: 1, generation: today })).rejects.toThrow(/not currently sponsorable/i);
    evidence('midnight/crossed', 'grace-window subscription spent after midnight; old day refused');
  });

  /**
   * The point of the policy machinery: a scheduled change is NOT in effect
   * before its activation time, and IS after — enforced on the PRIVATE path,
   * not just visible through a getter.
   */
  test('a change is inert before its activation time and binds after', async () => {
    const own = await deployOwnFpc(ctx, target, player);
    const rev = await currentRevision(own, player);

    await own.methods.schedule_settings(await bundleFrom(own, { maxUsers: 7 }), rev).send({ from: player });

    const before = unwrap(await own.methods.get_policy().simulate({ from: player }));
    expect(Number(before.max_users ?? before[2])).toBe(MAX_USERS);

    await warpChainBy(ctx.node, ACTIVATION, poke);

    const after = unwrap(await own.methods.get_policy().simulate({ from: player }));
    expect(Number(after.max_users ?? after[2])).toBe(7);

    // A getter proves nothing about what the PRIVATE path enforces: drive a
    // real sponsored send at a seat the new, lower cap forbids.
    await fund(own);
    const gen = generationAt(await chainTimestamp(ctx.node));
    const rejected = ctx.addresses[2] ?? other;
    await expect(sponsorOn(own, rejected, { seat: 9, generation: gen })).rejects.toThrow(
      /No sponsorship seats available/i,
    );
    evidence('activation', 'inert before the delay elapsed; afterwards the private path enforced the new cap');
  });

  /**
   * Clamping. A player holding an allowance issued under a larger policy must
   * be bound by the reduction at activation — otherwise old cohorts keep
   * spending under a later, higher fee ceiling and the loss bound is false.
   */
  test('a reduction clamps allowances already issued', async () => {
    const own = await deployOwnFpc(ctx, target, player);
    await fund(own);

    await warpChainToDayStart(ctx.node, poke);
    const gen = generationAt(await chainTimestamp(ctx.node));
    const claimant = ctx.addresses[2] ?? other;
    await sponsorOn(own, claimant, { seat: 0, generation: gen });
    expect((await allowanceOf(own, claimant, gen)).remaining).toBe(MAX_USES - 1);

    // Cut the per-player allowance to exactly what they have already spent.
    const rev = await currentRevision(own, player);
    await own.methods.schedule_settings(await bundleFrom(own, { maxUses: 1 }), rev).send({ from: player });
    await warpChainBy(ctx.node, ACTIVATION, poke);

    // Their allowance is gone, not merely smaller: they spent 1, the cap is 1.
    expect(await allowanceOf(own, claimant, gen)).toEqual({ subscribed: false, remaining: 0 });
    // The getter is NOT the enforcement: the spend itself must fail.
    await expect(sponsorOn(own, claimant, { generation: gen })).rejects.toThrow(/No sponsored transactions remaining/i);
    evidence('clamp', 'a reduction bound an allowance issued under the old policy, on the private path');
  });

  test('a raise reaches a player who had already run out', async () => {
    // The mirror of the clamp, and the harder direction: the player nullifier
    // bars re-subscribing, so the ONLY way a raise can reach an exhausted
    // player is if their terminal note was retained. Deleting terminal notes
    // silently turns every raise into a change that helps only players who
    // did not need it.
    const own = await deployOwnFpc(ctx, target, player, { maxUses: 1 });
    await fund(own);

    await warpChainToDayStart(ctx.node, poke);
    const gen = generationAt(await chainTimestamp(ctx.node));
    const claimant = ctx.addresses[2] ?? other;

    // One use, one cap: subscribing exhausts them immediately.
    await sponsorOn(own, claimant, { seat: 0, generation: gen });
    await expect(sponsorOn(own, claimant, { generation: gen })).rejects.toThrow(/No sponsored transactions remaining/i);

    const rev = await currentRevision(own, player);
    await own.methods.schedule_settings(await bundleFrom(own, { maxUses: 2 }), rev).send({ from: player });
    await warpChainBy(ctx.node, ACTIVATION, poke);

    expect(await allowanceOf(own, claimant, gen)).toEqual({ subscribed: true, remaining: 1 });
    // Enforcement, not the getter: the retained note must actually SPEND under
    // the raised cap — same generation throughout, so no rollover can be
    // mistaken for the revival.
    await sponsorOn(own, claimant, { generation: gen });
    evidence('raise', 'a raise reached a player who had already exhausted their allowance, same generation');
  });

  /**
   * The other half of the clamp: cutting the PLAYER cap must bind players
   * already admitted above it — and it reverts with its own message, because
   * telling an evicted player "today is full" would be false.
   */
  test('a player-cap cut evicts a seat already claimed above it', async () => {
    const own = await deployOwnFpc(ctx, target, player);
    await fund(own);
    await warpChainToDayStart(ctx.node, poke);
    const gen = generationAt(await chainTimestamp(ctx.node));
    const evicted = ctx.addresses[1] ?? other;

    // Seat 5 is fine under the deployed cap of 40.
    await sponsorOn(own, evicted, { seat: 5, generation: gen });

    const rev = await currentRevision(own, player);
    await own.methods.schedule_settings(await bundleFrom(own, { maxUsers: 3 }), rev).send({ from: player });
    await warpChainBy(ctx.node, ACTIVATION, poke);

    await expect(sponsorOn(own, evicted, { generation: gen })).rejects.toThrow(/seat no longer within capacity/i);
    evidence('seat-clamp', 'a player-cap cut evicted a seat claimed above it');
  });
});
