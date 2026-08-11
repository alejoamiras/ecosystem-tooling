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
import { maxFeePerGasWithHeadroom } from '../../gas-profile.js';
import { generationAt } from '../../generation.js';
import {
  ActionAborted,
  ActionRevalidationFailed,
  createActionPlan,
  digestOptions,
} from '../../operator/action-plan.js';
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
  let args: unknown[] = [];
  if (flags.get('args')) {
    try {
      args = JSON.parse(flags.require('args')) as unknown[];
    } catch {
      throw new CliUsageError('--args must be a JSON array');
    }
    if (!Array.isArray(args)) throw new CliUsageError('--args must be a JSON array');
  }

  // --artifact is the COMPILED artifact `aztec compile` writes (target/<crate>-<Contract>.json),
  // which is what an operator actually has on disk. It must be run through
  // loadContractArtifact before the SDK can use it — feeding the raw JSON
  // straight to Contract.at surfaces as "undefined passed to BaseField ctor"
  // deep inside the ABI layer.
  // biome-ignore lint/suspicious/noExplicitAny: version-loose contract artifact
  let artifact: any;
  {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(artifactPath, 'utf8'));
    } catch {
      throw new CliUsageError(`cannot read --artifact ${artifactPath} as JSON`);
    }
    const { loadContractArtifact } = await import('@aztec/aztec.js/abi');
    try {
      artifact = loadContractArtifact(raw as never);
    } catch (error) {
      throw new CliUsageError(
        `--artifact ${artifactPath} is not a compiled contract artifact ` +
          `(expected the JSON \`aztec compile\` writes to target/): ${(error as Error).message}`,
      );
    }
  }

  await withContext(flags, async (ctx) => {
    // The gas envelope is an explicit input by design — this command exists to
    // MEASURE what a profile costs, so inventing a default would beg the question.
    const gasProfile = ctx.gasProfile ? { ...ctx.gasProfile } : undefined;
    if (!gasProfile) {
      throw new CliUsageError(
        'measure needs a gas profile: return `gasProfile` from your config module (it defines the ' +
          'gas envelope the sponsored transactions declare). There is deliberately no default.',
      );
    }

    const [
      { Contract, getContractClassFromArtifact },
      { DefaultEntrypoint },
      { Gas, GasFees, GasSettings },
      { waitForTx },
    ] = await Promise.all([
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
      // The gas envelope determines what each send can cost, so it belongs in
      // what the operator confirms — and is snapshotted, since `ctx` is the
      // config module's own mutable object.
      gasProfileDigest: digestOptions({ ...gasProfile }),
      spendsRealFeeJuice: true,
    });
    if ((await makeConfirm(flags)(plan)) !== true) throw new ActionAborted(plan);

    // A fresh PXE knows neither contract: `.at()` alone leaves reads and proving
    // failing with "No artifact registered for contract class". Register both
    // deployed instances with their artifacts first (same step readPolicyState
    // performs for the paymaster).
    const quotaArtifact = (await import('../../../artifacts/QuotaFpc.js')).QuotaFpcContractArtifact;
    const register = async (address: typeof fpcAddress, contractArtifact: unknown) => {
      const instance = await ctx.node.getContract(address);
      if (!instance) throw new CliUsageError(`no contract deployed at ${address.toString()} on this node`);
      await (ctx.wallet as unknown as { registerContract(i: unknown, a: unknown): Promise<void> }).registerContract(
        instance,
        contractArtifact,
      );
    };
    await register(fpcAddress, quotaArtifact);
    await register(targetAddress, artifact);

    const targetContract = await Contract.at(targetAddress, artifact, ctx.wallet);
    const fpcContract = await Contract.at(fpcAddress, quotaArtifact, ctx.wallet);
    const alreadySubscribed = await hasSubscribed({
      node: ctx.node as never,
      fpcAddress,
      generation,
      player: ctx.from,
    });
    // The live policy, once: an unsubscribed player reads (false, 0), so the
    // budget for the first send is max_uses — without this the measurement
    // stops before sending anything. max_users is also the real seat range;
    // guessing it picks seats the contract rejects.
    const livePolicyRaw = await fpcContract.methods.get_policy().simulate({ from: ctx.from });
    const livePolicy = ((livePolicyRaw as { result?: unknown })?.result ?? livePolicyRaw) as {
      max_uses: number | bigint;
      max_users: number | bigint;
    };
    const maxUses = Number(livePolicy.max_uses);
    const maxUsers = Number(livePolicy.max_users);

    let sent = 0;
    const result = await measureSponsoredFee(
      {
        node: ctx.node,
        fpcAddress,
        sendSponsored: async () => {
          let seat: number | undefined;
          if (!alreadySubscribed && sent === 0) {
            const free = await findFreeSeat({ node: ctx.node as never, fpcAddress, generation, maxUsers });
            // null means the day is FULL. Coercing it to undefined would send
            // sponsor_and_execute for a player with no subscription, which the
            // contract rejects — refuse plainly instead.
            if (free === null) {
              throw new CliUsageError(
                `no sponsorship seats are free for generation ${generation} (max_users ${maxUsers}); ` +
                  'measurement needs a seat for an unsubscribed player — try after the daily reset.',
              );
            }
            seat = free;
          }
          const calls = [await targetContract.methods[method](...args).request()].flatMap((p) => p.calls);
          const payload = await buildSandwichPayload(
            { calls, player: ctx.from, fpcAddress, generation, seat },
            ctx.wallet as never,
            fpcContract as never,
          );
          sent += 1;
          // The whole CONFIRMED envelope, not just the totals: teardown limits
          // and the fee headroom are part of what the operator approved, and
          // letting the SDK invent its own would measure a different envelope
          // than the one on the plan.
          const minFees = await ctx.node.getCurrentMinFees();
          const withHeadroom = (fee: bigint) => maxFeePerGasWithHeadroom(gasProfile, fee);
          const gasSettings = GasSettings.fallback({
            gasLimits: new Gas(gasProfile.daGasLimit, gasProfile.l2GasLimit),
            teardownGasLimits: new Gas(gasProfile.teardownDaGasLimit, gasProfile.teardownL2GasLimit),
            maxFeesPerGas: new GasFees(
              withHeadroom(BigInt(minFees.feePerDaGas)),
              withHeadroom(BigInt(minFees.feePerL2Gas)),
            ),
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
          // The plan was confirmed against a specific chain; re-read identity
          // immediately before the send so a swapped endpoint cannot receive it.
          const nowInfo = await ctx.node.getNodeInfo();
          if (nowInfo.l1ChainId !== info.l1ChainId || nowInfo.rollupVersion !== info.rollupVersion) {
            throw new ActionRevalidationFailed(plan, 'chain identity changed between confirmation and broadcast');
          }
          await ctx.node.sendTx(tx as never);
          const receipt = await waitForTx(ctx.node, (tx as { getTxHash: () => never }).getTxHash());
          return { transactionFeeWei: BigInt((receipt as { transactionFee?: bigint })?.transactionFee ?? 0n) };
        },
        readQuotaInfo: async () => {
          const raw = await fpcContract.methods.get_quota_info(ctx.from, generation).simulate({ from: ctx.from });
          const unwrapped = (raw as { result?: unknown })?.result ?? raw;
          const [has, remaining] = unwrapped as [boolean, number | bigint];
          // Only an UNSUBSCRIBED player's first send reads as "no quota record
          // yet"; a subscribed player reporting no allowance has genuinely
          // exhausted the day. Without the subscription check, that player got
          // a full-allowance budget and then a sponsor_and_execute that the
          // contract rejects (round-7 finding 5) — and this now matches the
          // seat logic above, which was already conditioned on it.
          if (!has && sent === 0 && !alreadySubscribed) return { hasAllowance: true, remaining: maxUses };
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
