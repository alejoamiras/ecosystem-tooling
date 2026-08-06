/**
 * The measure library against a live network: real sponsored sends through the
 * package's own sandwich + send pipeline, real receipts, real balance deltas.
 * This is the operator "measure" capability's end-to-end exercise (the
 * repo-local CLI defers to exactly this pipeline).
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { FpcTestTargetContract } from '../../../artifacts/FpcTestTarget.js';
import type { QuotaFpcContract } from '../../../artifacts/QuotaFpc.js';
import { generationAt } from '../../generation.js';
import { measureSponsoredFee } from '../../operator/measure.js';
import { buildSandwichPayload } from '../../sandwich.js';
import { type Ctx, chainTimestamp, connect, evidence, fundWithFeeJuice, sendFromPaymaster } from '../harness.js';
import { allowanceOf, callsOf, deployOwnFpc, MAX_USES, unwrap } from '../suite-helpers.js';

describe('measureSponsoredFee (live)', () => {
  let ctx: Ctx;
  let target: FpcTestTargetContract;
  let fpc: QuotaFpcContract;
  let player: import('@aztec/stdlib/aztec-address').AztecAddress;
  let generation: number;

  beforeAll(async () => {
    ctx = await connect();
    player = ctx.addresses[0];
    const targetDeploy = FpcTestTargetContract.deploy(ctx.wallet);
    await targetDeploy.send({ from: player });
    target = await targetDeploy.register();
    // Its own paymaster: measurement consumes allowance, and the main suite's
    // shared instance must not lose uses to it.
    fpc = await deployOwnFpc(ctx, target, player);
    await fundWithFeeJuice(ctx.node, ctx.wallet, fpc.address, 10n ** 21n, player, () =>
      target.methods.ping().send({ from: player }),
    );
    generation = generationAt(await chainTimestamp(ctx.node));
  });

  test('measures real fees from receipts AND the balance delta agrees', async () => {
    let sent = 0;
    const result = await measureSponsoredFee(
      {
        node: ctx.node,
        fpcAddress: fpc.address,
        sendSponsored: async (i) => {
          const payload = await buildSandwichPayload(
            {
              calls: await callsOf(target.methods.record()),
              player,
              fpcAddress: fpc.address,
              generation,
              seat: i === 0 && sent === 0 ? 0 : undefined,
            },
            ctx.wallet,
            // biome-ignore lint/suspicious/noExplicitAny: structural QuotaFpcMethods
            fpc as any,
          );
          sent += 1;
          const { receipt } = await sendFromPaymaster(ctx, payload, player);
          // biome-ignore lint/suspicious/noExplicitAny: receipt shape is version-loose
          return { transactionFeeWei: BigInt((receipt as any)?.transactionFee ?? 0n) };
        },
        readQuotaInfo: async () => {
          const raw = unwrap(await fpc.methods.get_quota_info(player, generation).simulate({ from: player }));
          const [has, remaining] = raw;
          // Before the first send the player is unsubscribed: budget = full cap.
          return sent === 0
            ? { hasAllowance: true, remaining: MAX_USES }
            : { hasAllowance: Boolean(has), remaining: Number(remaining) };
        },
        onProgress: (m) => evidence('measure', m),
      },
      { count: 2 },
    );

    expect(result.measured).toBe(2);
    expect(result.perTransactionWei).toHaveLength(2);
    for (const fee of result.perTransactionWei) {
      expect(fee).toBeGreaterThan(0n);
    }
    // Two independent accountings of the same money must agree.
    expect(result.balanceDeltaWei).toBe(result.totalFromReceiptsWei);
    evidence('measure/result', {
      perTx: result.perTransactionWei.map(String),
      balanceDelta: result.balanceDeltaWei.toString(),
    });
  });
});
