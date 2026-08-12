/**
 * The integration suite: real compiled contracts, a live local network, and
 * this package's own client code. Everything the audits demanded proof of:
 * per-user caps, seat capacity, the fee ceiling (mandatory gap-closer),
 * allowlist binding, the account-class + unpublished binding INCLUDING the
 * full upgrade-attack path, and a transaction that simulates fine and then
 * reverts at INCLUSION.
 *
 * SAFE against a shared local network: nothing here warps the chain. The
 * time-travel cases live in ../warp (their own disposable network).
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { FpcTestTargetContract } from '../../../artifacts/FpcTestTarget.js';
import { QuotaFpcContract } from '../../../artifacts/QuotaFpc.js';
import { generationAt } from '../../generation.js';
import { computePlayerNullifier, computeSeatNullifier } from '../../nullifiers.js';
import { buildSandwichPayload } from '../../sandwich.js';
import {
  type Ctx,
  chainTimestamp,
  connect,
  evidence,
  feeJuiceOf,
  fundWithFeeJuice,
  sendFromPaymaster,
} from '../harness.js';
import {
  allowanceOf,
  awaitPolicyReadable,
  bundleFrom,
  callsOf,
  currentRevision,
  deployOwnFpc,
  initializerlessClassId,
  MAX_FEE,
  MAX_USERS,
  MAX_USES,
  type Suite,
  sponsorVia,
  unwrap,
  ZERO,
} from '../suite-helpers.js';

describe('QuotaFpc integration', () => {
  let ctx: Ctx;
  let fpc: QuotaFpcContract;
  let target: FpcTestTargetContract;
  let decoy: FpcTestTargetContract;
  let player: import('@aztec/stdlib/aztec-address').AztecAddress;
  let other: import('@aztec/stdlib/aztec-address').AztecAddress;
  let generation: number;
  let suite: Suite;

  const recordCall = () => callsOf(target.methods.record());
  const sponsor = (
    // biome-ignore lint/suspicious/noExplicitAny: FunctionCall arrays from interactions
    calls: any[],
    from: import('@aztec/stdlib/aztec-address').AztecAddress,
    opts: { seat?: number; generation?: number } = {},
  ) => sponsorVia(suite, calls, from, opts);

  beforeAll(async () => {
    ctx = await connect();
    player = ctx.addresses[0];
    other = ctx.addresses[1];
    generation = generationAt(await chainTimestamp(ctx.node));

    const targetDeploy = FpcTestTargetContract.deploy(ctx.wallet);
    await targetDeploy.send({ from: player });
    target = await targetDeploy.register();

    const { Fr } = await import('@aztec/foundation/curves/bn254');
    const decoyDeploy = FpcTestTargetContract.deploy(ctx.wallet, {
      salt: Fr.random(),
      // biome-ignore lint/suspicious/noExplicitAny: deploy options are version-loose
    } as any);
    await decoyDeploy.send({ from: player });
    decoy = await decoyDeploy.register();

    const allowed = [target.address, ...Array(11).fill(ZERO)];
    const allowedClasses = [await initializerlessClassId(), 0n, 0n, 0n];
    const fpcDeploy = QuotaFpcContract.deploy(
      ctx.wallet,
      player, // admin
      MAX_FEE,
      MAX_USES,
      MAX_USERS,
      allowed,
      allowedClasses,
      true,
    );
    await fpcDeploy.send({ from: player });
    fpc = await fpcDeploy.register();

    await fundWithFeeJuice(ctx.node, ctx.wallet, fpc.address, 10n ** 21n, player, () =>
      target.methods.ping().send({ from: player }),
    );
    suite = { ctx, fpc, target, generationOf: () => generation };

    evidence('setup', {
      fpc: fpc.address.toString(),
      target: target.address.toString(),
      generation,
      fpcFeeJuice: (await feeJuiceOf(ctx.node, fpc.address)).toString(),
    });
  });

  test('constructor rejects a policy that cannot work', async () => {
    const allowed = [target.address, ...Array(11).fill(ZERO)];
    const classes = [await initializerlessClassId(), 0n, 0n, 0n];
    await expect(
      QuotaFpcContract.deploy(ctx.wallet, player, MAX_FEE, 0, MAX_USERS, allowed, classes, true).send({
        from: player,
      }),
    ).rejects.toThrow(/max_uses/);
    await expect(
      QuotaFpcContract.deploy(
        ctx.wallet,
        player,
        MAX_FEE,
        MAX_USES,
        MAX_USERS,
        Array(12).fill(ZERO),
        classes,
        true,
      ).send({ from: player }),
    ).rejects.toThrow(/at least one allowed target/);
    // All-zero account classes would sponsor no account at all — same
    // deploy-a-brick mistake as an empty target allowlist.
    await expect(
      QuotaFpcContract.deploy(ctx.wallet, player, MAX_FEE, MAX_USES, MAX_USERS, allowed, [0n, 0n, 0n, 0n], true).send({
        from: player,
      }),
    ).rejects.toThrow(/at least one allowed account class/);
  });

  /**
   * The bootstrap trap. `DelayedPublicMutable` routes every write through the
   * current delay, including the constructor's — so if the delay were declared
   * as 12h, the paymaster would read an all-zero policy (silently, not as an
   * error) and sponsor nothing for its first 12 hours.
   */
  test('settings are live at the first post-deploy anchor, not 12h later', async () => {
    const policy = unwrap(await fpc.methods.get_policy().simulate({ from: player }));
    expect(Number(policy.max_uses ?? policy[1])).toBe(MAX_USES);
    expect(Number(policy.max_users ?? policy[2])).toBe(MAX_USERS);
    expect(BigInt(policy.max_fee ?? policy[0])).toBe(MAX_FEE);

    const targets = unwrap(await fpc.methods.get_allowed_targets().simulate({ from: player }));
    // biome-ignore lint/suspicious/noExplicitAny: simulate() array items are version-loose
    const live = targets.map((t: any) => t.toString()).filter((t: string) => !/^0x0+$/.test(t));
    expect(live).toContain(target.address.toString());
  });

  test('only the admin can schedule a change', async () => {
    const bundle = await bundleFrom(fpc, { maxUses: MAX_USES });
    await expect(fpc.methods.schedule_settings(bundle, 0n).send({ from: other })).rejects.toThrow(
      /caller is not admin/i,
    );
  });

  test("the setter re-asserts the constructor's invariants", async () => {
    // A zero bundle is fail-closed but would brick sponsorship for 12h with no
    // shortcut, so the guards live in the contract, not only in the tooling.
    const zeroUses = await bundleFrom(fpc, { maxUses: 0 });
    await expect(fpc.methods.schedule_settings(zeroUses, 0n).send({ from: player })).rejects.toThrow(/max_uses/i);

    const noTargets = await bundleFrom(fpc, { targets: [] });
    await expect(fpc.methods.schedule_settings(noTargets, 0n).send({ from: player })).rejects.toThrow(
      /at least one allowed target/i,
    );
  });

  test('a stale expected_revision is rejected, a correct one replaces', async () => {
    const rev = await currentRevision(fpc, player);
    await fpc.methods.schedule_settings(await bundleFrom(fpc, { maxUses: 2 }), rev).send({ from: player });

    // Same revision again: this is the two-operators race, and it must lose.
    await expect(
      fpc.methods.schedule_settings(await bundleFrom(fpc, { maxUses: 4 }), rev).send({ from: player }),
    ).rejects.toThrow(/changed since you last read/i);

    // With the new revision it replaces the pending change (no queue).
    await fpc.methods.schedule_settings(await bundleFrom(fpc, { maxUses: MAX_USES }), rev + 1n).send({ from: player });
    expect(await currentRevision(fpc, player)).toBe(rev + 2n);
  });

  test('a player whose account class is not allowlisted cannot be sponsored', async () => {
    // A paymaster that allowlists some OTHER class: the harness player's real
    // initializerless account is then exactly the attacker shape C1 described.
    // The transaction must not even prove (no funding needed: the assert fires
    // in private setup).
    const strangerClasses = [0x1234n, 0n, 0n, 0n];
    const wrongClassDeploy = QuotaFpcContract.deploy(
      ctx.wallet,
      player,
      MAX_FEE,
      MAX_USES,
      MAX_USERS,
      [target.address, ...Array(11).fill(ZERO)],
      strangerClasses,
      true,
    );
    await wrongClassDeploy.send({ from: player });
    const wrongClassFpc = await awaitPolicyReadable(await wrongClassDeploy.register(), player);

    const payload = await buildSandwichPayload(
      { calls: await recordCall(), player, fpcAddress: wrongClassFpc.address, generation, seat: 0 },
      ctx.wallet,
      // biome-ignore lint/suspicious/noExplicitAny: structural QuotaFpcMethods
      wrongClassFpc as any,
    );
    await expect(sendFromPaymaster(ctx, payload, player)).rejects.toThrow(/account class is not sponsored/i);
    evidence('account-class-binding', 'an account class outside the allowlist cannot be proven');
  });

  /**
   * The upgrade bypass, closed — the FULL attack path (plan D5.5 mandatory).
   *
   * An account whose class IS allowlisted must still be refused when it is
   * PUBLISHED, because only a published account can call
   * `ContractInstanceRegistry::update` and swap itself for hostile code the
   * paymaster would then sponsor (it can only see the original class). This
   * test walks the entire path: publish a real account of the blessed class,
   * SCHEDULE its upgrade toward a different class through the real registry,
   * then prove sponsorship refuses it.
   */
  test('a published account that scheduled an upgrade is refused despite an allowlisted class', async () => {
    const { publishInstance, publishContractClass } = await import('@aztec/aztec.js/deployment');
    const { Fr, Fq } = await import('@aztec/foundation/curves/bn254');
    const { SchnorrAccountContractArtifact, SchnorrInitializerlessAccountContractArtifact } = await import(
      '@aztec/accounts/schnorr'
    );
    const { getContractClassFromArtifact } = await import('@aztec/aztec.js/contracts');

    // Publishing an instance requires its class to be publicly registered.
    // Publication is permanent, so both publishes are conditional: a re-run
    // against the same chain must not fail on classes already published.
    const classId = await initializerlessClassId();
    const { isContractClassPubliclyRegistered } = await ctx.wallet.getContractClassMetadata(new Fr(classId));
    if (!isContractClassPubliclyRegistered) {
      await (await publishContractClass(ctx.wallet, SchnorrInitializerlessAccountContractArtifact)).send({
        from: player,
      });
    }
    // The "hostile" class the account will upgrade toward. Any registered
    // class works — using the plain Schnorr class keeps it a REAL account
    // class rather than a synthetic artifact.
    const hostileClass = await getContractClassFromArtifact(SchnorrAccountContractArtifact);
    const hostileMeta = await ctx.wallet.getContractClassMetadata(hostileClass.id);
    if (!hostileMeta.isContractClassPubliclyRegistered) {
      await (await publishContractClass(ctx.wallet, SchnorrAccountContractArtifact)).send({ from: player });
    }

    // A REAL account of the blessed class, deliberately published. A dedicated
    // account, never a shared harness one: publishing is permanent, so
    // borrowing a shared address would leak this test's effects into others.
    const victimAccount = await ctx.wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), Fq.random());
    const victim = victimAccount.address;
    const { instance: victimInstance } = await ctx.wallet.getContractMetadata(victim);
    await publishInstance(ctx.wallet, {
      // biome-ignore lint/suspicious/noExplicitAny: preimage/instance shapes are version-loose
      ...(victimInstance as any),
      // biome-ignore lint/suspicious/noExplicitAny: see above
      currentContractClassId: (victimInstance as any).originalContractClassId,
      // biome-ignore lint/suspicious/noExplicitAny: see above
    } as any).send({ from: player });

    // Assert it really is published; an unlanded publish would make the
    // rejection below prove nothing at all.
    const publishedDeadline = Date.now() + 120_000;
    for (;;) {
      const { isContractPublished } = await ctx.wallet.getContractMetadata(victim);
      if (isContractPublished) break;
      if (Date.now() > publishedDeadline) {
        throw new Error(`${victim} was never published; the test cannot prove anything`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    // THE ATTACK STEP: from the victim itself, schedule the class swap through
    // the real registry. The victim self-pays, so fund it first (the local L1
    // faucet mints a fixed 1e21 — smaller amounts are refused).
    await fundWithFeeJuice(ctx.node, ctx.wallet, victim, 10n ** 21n, player, () =>
      target.methods.ping().send({ from: player }),
    );
    const { ContractInstanceRegistryContract } = await import('@aztec/aztec.js/protocol');
    await ContractInstanceRegistryContract.at(ctx.wallet).methods.update(hostileClass.id).send({ from: victim });
    evidence('upgrade-scheduled', {
      victim: victim.toString(),
      toward: hostileClass.id.toString(),
    });

    // Standard test paymaster (allowlists the blessed initializerless class),
    // so only the unpublished requirement can reject the victim — exactly the
    // property under test.
    const publishedFpc = await deployOwnFpc(ctx, target, player);

    // Fund it. An unfunded paymaster is rejected by the NODE for fee-payer
    // balance — which would mask whether the private assert fired at all.
    await fundWithFeeJuice(ctx.node, ctx.wallet, publishedFpc.address, 10n ** 21n, player, () =>
      target.methods.ping().send({ from: player }),
    );

    const payload = await buildSandwichPayload(
      { calls: await recordCall(), player: victim, fpcAddress: publishedFpc.address, generation, seat: 0 },
      ctx.wallet,
      // biome-ignore lint/suspicious/noExplicitAny: structural QuotaFpcMethods
      publishedFpc as any,
    );
    // The class matches, so only the unpublished requirement can reject this —
    // assert on ITS failure (the non-inclusion proof), not merely that
    // something threw, or an unrelated error would score as a pass.
    await expect(sendFromPaymaster(ctx, payload, victim)).rejects.toThrow(/nullifier non-inclusion/i);
    evidence(
      'upgrade-bypass-closed',
      'an account that walked the real publish->registry-update path is refused despite an allowlisted class',
    );
  });

  /**
   * MANDATORY gap-closer (handoff §6): the fee ceiling, end-to-end. A
   * paymaster deployed with a 1-wei ceiling must refuse to even PROVE a
   * realistic transaction. Deployed raw (not through the operator library,
   * whose fee-floor rail would rightly refuse this config — the rail is the
   * point, so the test goes underneath it).
   */
  test('the fee ceiling makes an over-budget transaction unprovable', async () => {
    const lowCeiling = await deployOwnFpc(ctx, target, player, { maxFeeWei: 1n }); // one-wei ceiling
    // No funding needed: the ceiling assert fires in private setup, before any
    // balance is consulted.
    const payload = await buildSandwichPayload(
      { calls: await recordCall(), player, fpcAddress: lowCeiling.address, generation, seat: 0 },
      ctx.wallet,
      // biome-ignore lint/suspicious/noExplicitAny: structural QuotaFpcMethods
      lowCeiling as any,
    );
    await expect(sendFromPaymaster(ctx, payload, player)).rejects.toThrow(
      /Gas settings exceed the sponsorship allowance/i,
    );
    evidence('fee-ceiling', 'a 1-wei ceiling made a realistic transaction unprovable');
  });

  test('a sponsored call: paymaster pays, app sees the USER, allowance opens', async () => {
    const fpcBefore = await feeJuiceOf(ctx.node, fpc.address);
    const playerBefore = await feeJuiceOf(ctx.node, player);

    await sponsor(await recordCall(), player, { seat: 0 });

    const observed = unwrap(await target.methods.get_last_caller().simulate({ from: player })).toString();
    evidence('msg-sender', { observed, player: player.toString(), fpc: fpc.address.toString() });
    expect(observed).toBe(player.toString());

    const fpcAfter = await feeJuiceOf(ctx.node, fpc.address);
    const playerAfter = await feeJuiceOf(ctx.node, player);
    evidence('who-paid', {
      fpcPaid: (fpcBefore - fpcAfter).toString(),
      playerPaid: (playerBefore - playerAfter).toString(),
    });
    expect(fpcAfter).toBeLessThan(fpcBefore);
    expect(playerAfter).toBe(playerBefore);

    expect(await allowanceOf(fpc, player, generation)).toEqual({ subscribed: true, remaining: MAX_USES - 1 });
  });

  test('TS and Noir compute identical nullifiers', async () => {
    const seatOnChain = unwrap(
      await fpc.methods.compute_seat_nullifier(generation, 7).simulate({ from: player }),
    ).toString();
    const playerOnChain = unwrap(
      await fpc.methods.compute_player_nullifier(generation, player).simulate({ from: player }),
    ).toString();
    const seatLocal = (await computeSeatNullifier(generation, 7)).toString();
    const playerLocal = (await computePlayerNullifier(generation, player)).toString();

    evidence('nullifier-parity', { seatOnChain, seatLocal, playerOnChain, playerLocal });
    // The chain returns decimal, the client hex — compare values, not text.
    expect(BigInt(seatLocal)).toBe(BigInt(seatOnChain));
    expect(BigInt(playerLocal)).toBe(BigInt(playerOnChain));
  });

  test('the allowlist binds sponsorship to the app', async () => {
    await expect(sponsor(await callsOf(decoy.methods.record()), other, { seat: 5 })).rejects.toThrow(/non-allowlisted/);
    evidence('allowlist', 'a call to an unlisted contract cannot be proven');
  });

  test('one subscription per user per day', async () => {
    await expect(sponsor(await recordCall(), player, { seat: 9 })).rejects.toThrow();
    evidence('player-cap', 'second subscribe by the same user rejected');
  });

  test('the allowance is exactly max_uses, then it stops', async () => {
    for (let i = 0; i < MAX_USES - 1; i++) {
      await sponsor(await recordCall(), player);
      evidence('after-sponsor', { call: i + 1, ...(await allowanceOf(fpc, player, generation)) });
    }
    // The last pop's nullifier reaches the viewer one sync behind the
    // transaction itself, so tolerate a short delay before asserting exhaustion.
    const deadline = Date.now() + 30_000;
    while ((await allowanceOf(fpc, player, generation)).subscribed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect((await allowanceOf(fpc, player, generation)).subscribed).toBe(false);

    await expect(sponsor(await recordCall(), player)).rejects.toThrow(/No sponsored transactions remaining/);
  });

  test('each user gets their own allowance', async () => {
    await sponsor(await recordCall(), other, { seat: 1 });
    expect(await allowanceOf(fpc, other, generation)).toEqual({ subscribed: true, remaining: MAX_USES - 1 });
  });

  test('stale and premature generations are refused', async () => {
    const third = ctx.addresses[2] ?? other;
    await expect(sponsor(await recordCall(), third, { seat: 2, generation: generation - 1 })).rejects.toThrow(
      /not currently sponsorable/,
    );
    // generation + 2, not + 1: the contract ACCEPTS tomorrow inside the last
    // 600s of a day, so `+ 1` made this test fail (and burn a seat) whenever it
    // ran between 23:50 and midnight UTC. Day-after-tomorrow is refused
    // unconditionally; the grace window itself is covered by the warp suite.
    await expect(sponsor(await recordCall(), third, { seat: 3, generation: generation + 2 })).rejects.toThrow(
      /not currently sponsorable/,
    );
  });

  test('a seat beyond capacity is refused', async () => {
    const third = ctx.addresses[2] ?? other;
    await expect(sponsor(await recordCall(), third, { seat: MAX_USERS + 1 })).rejects.toThrow(
      /No sponsorship seats available/,
    );
  });

  /**
   * Both transactions simulate cleanly, then the second reverts in the public
   * phase at inclusion time. The audits' worry was that this strands a user —
   * seat burned, allowance lost. It must not.
   */
  test('an inclusion-time revert consumes the allowance without stranding the user', async () => {
    const third = ctx.addresses[2] ?? other;
    const before = await allowanceOf(fpc, third, generation);
    if (!before.subscribed) {
      await sponsor(await callsOf(target.methods.claim_once()), third, { seat: 4 });
    }
    const afterFirst = await allowanceOf(fpc, third, generation);
    const claimed = Boolean(unwrap(await target.methods.is_claimed().simulate({ from: third })));
    evidence('inclusion-revert/first', { allowance: afterFirst, claimed });

    // The flag is now set, so this simulates against pre-state but reverts
    // publicly. A transaction that is INCLUDED and then reverts still throws —
    // classify on the error itself rather than on the fact that one was raised.
    const fpcBefore = await feeJuiceOf(ctx.node, fpc.address);
    let includedAndReverted = false;
    try {
      await sponsor(await callsOf(target.methods.claim_once()), third);
    } catch (err) {
      const message = String(err);
      includedAndReverted = /reverted/i.test(message);
      evidence('inclusion-revert/second', { includedAndReverted, rejected: message.slice(0, 160) });
    }
    const after = await allowanceOf(fpc, third, generation);
    const fpcAfter = await feeJuiceOf(ctx.node, fpc.address);
    evidence('inclusion-revert/outcome', {
      includedAndReverted,
      allowanceBefore: afterFirst,
      allowanceAfter: after,
      fpcPaid: (fpcBefore - fpcAfter).toString(),
    });

    if (includedAndReverted) {
      // Landed and failed in the public phase: it consumed exactly one use and
      // the paymaster really paid, while the player keeps their seat and the
      // rest of the allowance.
      expect(after.remaining).toBe(afterFirst.remaining - 1);
      expect(after.subscribed).toBe(true);
      expect(fpcBefore - fpcAfter).toBeGreaterThan(0n);
    } else {
      // Rejected before submission: nothing spent at all.
      expect(after.remaining).toBe(afterFirst.remaining);
      expect(fpcBefore - fpcAfter).toBe(0n);
    }
  });
});
