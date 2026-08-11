/**
 * `measure` — drive real sponsored transactions and report what they cost.
 *
 * This SPENDS the paymaster's fee juice and consumes the player's daily
 * allowance, so it goes through the same confirm-by-digest gate every other
 * state-changing command uses. (The reference implementation this was ported
 * from had no gate at all — it sent live transactions unconditionally.)
 *
 * The target contract is named by artifact PATH, not imported: this command is
 * app-agnostic, so it works for any allowlisted contract.
 */
import { readFileSync } from 'node:fs';
import { generationAt } from '../../generation.js';
import { createActionPlan, digestOptions } from '../../operator/action-plan.js';
import { formatFeeJuiceWei } from '../../operator/internal/format.js';
import { measureSponsoredFee } from '../../operator/measure.js';
import { buildSandwichPayload } from '../../sandwich.js';
import { findFreeSeat, hasSubscribed } from '../../seat-picker.js';
import { makeConfirm } from '../internal/confirm.js';
import { withContext } from '../internal/context.js';
import { CliUsageError, type FlagSchema, type ParsedFlags } from '../internal/flags.js';

export const schema: FlagSchema = {
  fpc: { type: 'string' },
  'config-module': { type: 'string' },
  target: { type: 'string' },
  artifact: { type: 'string' },
  method: { type: 'string' },
  args: { type: 'string' },
  count: { type: 'string' },
  yes: { type: 'boolean' },
};

export const usage =
  'measure --fpc 0x… --target 0x… --artifact <compiled-artifact.json> --config-module <path>\n' +
  '        [--method <name>] [--args <json-array>] [--count N] [--yes]\n' +
  '  SPENDS real fee juice and consumes daily allowance. Without --yes: plan only.';

export async function run(flags: ParsedFlags): Promise<void> {
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const fpcAddress = AztecAddress.fromStringUnsafe(flags.require('fpc'));
  const targetAddress = AztecAddress.fromStringUnsafe(flags.require('target'));
  const artifactPath = flags.require('artifact');
  const method = flags.get('method') ?? 'ping';
  const count = Number(flags.get('count') ?? '2');
  if (!Number.isInteger(count) || count < 1) throw new CliUsageError('--count must be a positive integer');
  const args = flags.get('args') ? (JSON.parse(flags.require('args')) as unknown[]) : [];

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  await withContext(flags, async (ctx) => {
    // The gas envelope is an explicit input by design — this command exists to
    // MEASURE what a profile costs, so inventing a default would beg the question.
    const gasProfile = ctx.gasProfile;
    if (!gasProfile) {
      throw new CliUsageError(
        'measure needs a gas profile: return `gasProfile` from your config module (it defines the ' +
          'gas envelope the sponsored transactions declare). There is deliberately no default.',
      );
    }

    const [{ Contract, getContractClassFromArtifact }, { DefaultEntrypoint }, { Gas, GasSettings }, { waitForTx }] =
      await Promise.all([
        import('@aztec/aztec.js/contracts'),
        import('@aztec/entrypoints/default'),
        import('@aztec/stdlib/gas'),
        import('@aztec/aztec.js/node'),
      ]);

    const info = await ctx.node.getNodeInfo();
    const chainTimestamp = BigInt((await ctx.node.getBlockData('latest'))?.header?.globalVariables?.timestamp ?? 0);
    const generation = generationAt(chainTimestamp);
    const artifactClassId = (await getContractClassFromArtifact(artifact)).id.toString();

    // Everything that affects what gets executed is in the confirmed digest.
    const plan = createActionPlan('measure-sponsored-fee', {
      l1ChainId: info.l1ChainId,
      rollupVersion: info.rollupVersion,
      fpc: fpcAddress.toString(),
      target: targetAddress.toString(),
      targetClassId: artifactClassId,
      method,
      argsDigest: digestOptions({ args }),
      count,
      generation,
      player: ctx.from.toString(),
      sendOptionsDigest: digestOptions(ctx.sendOptions ?? {}),
      spendsRealFeeJuice: true,
    });
    if ((await makeConfirm(flags)(plan)) !== true) {
      console.error('Aborted: nothing was sent.');
      process.exitCode = 2;
      return;
    }

    const targetContract = await Contract.at(targetAddress, artifact, ctx.wallet);
    const fpcContract = await Contract.at(
      fpcAddress,
      (await import('../../../artifacts/QuotaFpc.js')).QuotaFpcContractArtifact,
      ctx.wallet,
    );
    const alreadySubscribed = await hasSubscribed({
      node: ctx.node as never,
      fpcAddress,
      generation,
      player: ctx.from,
    });

    let sent = 0;
    const result = await measureSponsoredFee(
      {
        node: ctx.node,
        fpcAddress,
        sendSponsored: async () => {
          const seat =
            !alreadySubscribed && sent === 0
              ? ((await findFreeSeat({ node: ctx.node as never, fpcAddress, generation, maxUsers: 1024 })) ?? undefined)
              : undefined;
          const calls = [await targetContract.methods[method](...args).request()].flatMap((p) => p.calls);
          const payload = await buildSandwichPayload(
            { calls, player: ctx.from, fpcAddress, generation, seat },
            ctx.wallet as never,
            fpcContract as never,
          );
          sent += 1;
          const gasSettings = GasSettings.fallback({
            gasLimits: new Gas(gasProfile.daGasLimit, gasProfile.l2GasLimit),
            maxFeesPerGas: await ctx.node.getCurrentMinFees(),
          });
          const request = await new DefaultEntrypoint().createTxExecutionRequest(
            payload,
            gasSettings,
            await (ctx.wallet as unknown as { getChainInfo: () => Promise<never> }).getChainInfo(),
          );
          const proven = await (
            ctx.wallet as unknown as {
              pxe: { proveTx: (r: unknown, o: unknown) => Promise<{ toTx: () => Promise<unknown> }> };
            }
          ).pxe.proveTx(request, { scopes: [ctx.from] });
          const tx = await proven.toTx();
          await ctx.node.sendTx(tx as never);
          const receipt = await waitForTx(ctx.node, (tx as { getTxHash: () => never }).getTxHash());
          return { transactionFeeWei: BigInt((receipt as { transactionFee?: bigint })?.transactionFee ?? 0n) };
        },
        readQuotaInfo: async () => {
          const raw = await fpcContract.methods.get_quota_info(ctx.from, generation).simulate({ from: ctx.from });
          const unwrapped = (raw as { result?: unknown })?.result ?? raw;
          const [has, remaining] = unwrapped as [boolean, number | bigint];
          return { hasAllowance: Boolean(has), remaining: Number(remaining) };
        },
        onProgress: (m) => console.log(`  ${m}`),
      },
      { count },
    );

    console.log(`\nMeasured ${result.measured} sponsored transaction(s) against ${targetAddress.toString()}:`);
    for (const [i, fee] of result.perTransactionWei.entries()) {
      console.log(`  tx ${i + 1}  ${formatFeeJuiceWei(fee)}`);
    }
    console.log(`  total (receipts) ${formatFeeJuiceWei(result.totalFromReceiptsWei)}`);
    console.log(`  balance delta    ${formatFeeJuiceWei(result.balanceDeltaWei)}`);
    if (result.balanceDeltaWei !== result.totalFromReceiptsWei) {
      console.log('  NOTE: the two accountings disagree — investigate before trusting these numbers.');
    }
  });
}
