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
import { CliUsageError, type FlagSchema, type ParsedFlags, requireAddressFlag } from '../internal/flags.js';

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
  'measure --fpc 0x… --target 0x… --artifact <compiled-artifact.json> --method <name>\n' +
  '        --config-module <path> [--args <json-array>] [--count N] [--yes]\n' +
  '  SPENDS real fee juice and consumes daily allowance. Without --yes: plan only.';

export async function run(flags: ParsedFlags): Promise<void> {
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const fpcAddress = AztecAddress.fromStringUnsafe(requireAddressFlag(flags, 'fpc'));
  const targetAddress = AztecAddress.fromStringUnsafe(requireAddressFlag(flags, 'target'));
  const artifactPath = flags.require('artifact');
  // No default: `ping` exists only in this repo's own test target, so against
  // a real contract it became `methods['ping']` === undefined and died as a
  // bare TypeError AFTER the confirm gate — exit 1 ("something may have
  // happened") for what is a pure usage error (round-8 finding 2).
  const method = flags.require('method');
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

  // The artifact is already loaded and the method name is already known, so a
  // typo (or a utility-only function) can be refused HERE rather than after a
  // human has approved a plan that cannot execute (round-10).
  // BOTH arrays: loadContractArtifact splits ordinary public methods out into
  // `nonDispatchPublicFunctions`, so checking `functions` alone rejected valid
  // public targets while accepting utility functions, which are not
  // transactions at all (round-11). isOnlySelf functions can only be called by
  // the contract itself, and an initializer is not a measurable action.
  const callable = [...(artifact.functions ?? []), ...(artifact.nonDispatchPublicFunctions ?? [])] as {
    name?: string;
    functionType?: string;
    isOnlySelf?: boolean;
    isInitializer?: boolean;
    parameters?: unknown[];
  }[];
  const sendable = callable.filter(
    (f) =>
      (f.functionType === 'private' || f.functionType === 'public') &&
      !f.isOnlySelf &&
      !f.isInitializer &&
      // The SDK's own public entrypoint, not an app method: it is exposed on
      // Contract.methods, so suggesting it invites a failure after the confirm
      // gate (round-12).
      f.name !== 'public_dispatch',
  );
  const chosen = sendable.find((f) => f.name === method);
  if (!chosen) {
    const names = sendable
      .map((f) => f.name)
      .filter((n): n is string => typeof n === 'string')
      .join(', ');
    throw new CliUsageError(`--method ${method} is not a sendable function of ${artifactPath}. Available: ${names}`);
  }
  // Arity is decidable from the artifact already in hand: without this the
  // wrong number of --args built a plan, a human approved its digest, and
  // aztec.js raised the arity error INSIDE the send — exit 1 for a typo
  // (round-16).
  const expectedArity = chosen.parameters?.length ?? 0;
  if (args.length !== expectedArity) {
    throw new CliUsageError(
      `--method ${method} takes ${expectedArity} argument(s), but --args supplied ${args.length}`,
    );
  }

  await withContext(flags, async (ctx) => {
    // Copied ONCE, all of them: ctx is the config module's own object, so a
    // getter re-read after the confirm gate could return a different account,
    // node or wallet than the one the plan was built and checked against —
    // including handing the capability check one PXE and the send another
    // (round-19). Every sibling command copies its execution inputs into a
    // plain deps object for exactly this reason.
    const { from, node, wallet } = { from: ctx.from, node: ctx.node, wallet: ctx.wallet };
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

    const info = await node.getNodeInfo();
    const chainTimestamp = BigInt((await node.getBlockData('latest'))?.header?.globalVariables?.timestamp ?? 0);
    const generation = generationAt(chainTimestamp);
    const artifactClassId = (await getContractClassFromArtifact(artifact)).id.toString();

    // Registration and the live-policy read are read-only and local, and the
    // allowance preflight below needs them — so they happen BEFORE the plan
    // rather than between the confirm and the sends (round-13).
    // A fresh PXE knows neither contract: `.at()` alone leaves reads and proving
    // failing with "No artifact registered for contract class". Register both
    // deployed instances with their artifacts first (same step readPolicyState
    // performs for the paymaster).
    const quotaArtifact = (await import('../../../artifacts/QuotaFpc.js')).QuotaFpcContractArtifact;
    const register = async (address: typeof fpcAddress, contractArtifact: unknown) => {
      const instance = await node.getContract(address);
      if (!instance) throw new CliUsageError(`no contract deployed at ${address.toString()} on this node`);
      // registerContract does NOT check that the artifact matches the deployed
      // class, so a wrong --artifact previously surfaced during proving, after
      // the operator had approved a plan naming that artifact's class id
      // (round-18).
      const deployedClassId = (
        instance as unknown as { currentContractClassId?: { toString(): string } }
      ).currentContractClassId?.toString();
      const artifactClassId = (await getContractClassFromArtifact(contractArtifact as never)).id.toString();
      // Absent is a REFUSAL, not a pass: failing open here would let a node
      // wrapper that omits the field wave through the wrong artifact, which is
      // exactly what this check exists to stop (round-19).
      if (!deployedClassId) {
        throw new CliUsageError(
          `the node did not report a contract class for ${address.toString()}, so the supplied artifact cannot be ` +
            `checked against it; refusing rather than proving against an unverified contract`,
        );
      }
      if (deployedClassId !== artifactClassId) {
        throw new CliUsageError(
          `the contract at ${address.toString()} has class ${deployedClassId}, but the artifact supplied is class ` +
            `${artifactClassId} — measuring it would prove against a different contract`,
        );
      }
      await (wallet as unknown as { registerContract(i: unknown, a: unknown): Promise<void> }).registerContract(
        instance,
        contractArtifact,
      );
    };
    await register(fpcAddress, quotaArtifact);
    await register(targetAddress, artifact);

    const targetContract = await Contract.at(targetAddress, artifact, wallet);
    const fpcContract = await Contract.at(fpcAddress, quotaArtifact, wallet);
    const alreadySubscribed = await hasSubscribed({
      node: node as never,
      fpcAddress,
      generation,
      player: from,
    });
    // The live policy, once: an unsubscribed player reads (false, 0), so the
    // budget for the first send is max_uses — without this the measurement
    // stops before sending anything. max_users is also the real seat range;
    // guessing it picks seats the contract rejects.
    const livePolicyRaw = await fpcContract.methods.get_policy().simulate({ from });
    const livePolicy = ((livePolicyRaw as { result?: unknown })?.result ?? livePolicyRaw) as {
      max_uses: number | bigint;
      max_users: number | bigint;
    };
    const maxUses = Number(livePolicy.max_uses);
    const maxUsers = Number(livePolicy.max_users);

    // The FEE CEILING, read once and bound into the plan: it was read inside
    // the send, after confirmation, so two runs of an identical plan — same
    // digest — could declare materially different maximum fees. Every send
    // reuses this exact envelope (round-20).
    const minFees = await node.getCurrentMinFees();
    const withHeadroom = (fee: bigint) => maxFeePerGasWithHeadroom(gasProfile, fee);
    const maxFeePerDaGas = withHeadroom(BigInt(minFees.feePerDaGas));
    const maxFeePerL2Gas = withHeadroom(BigInt(minFees.feePerL2Gas));
    const confirmedMaxFees = new GasFees(maxFeePerDaGas, maxFeePerL2Gas);

    // Both done BEFORE the plan: `.request()` is what validates argument TYPES
    // against the ABI (arity is checked earlier, offline), and the wallet's
    // chain identity was previously read only inside the send — after a human
    // had approved a plan built from the NODE's identity (round-17).
    // biome-ignore lint/suspicious/noExplicitAny: version-loose call shape
    let calls: any[];
    try {
      calls = [await targetContract.methods[method](...args).request()].flatMap((p) => p.calls);
    } catch (error) {
      throw new CliUsageError(`--args does not match ${method}'s ABI: ${(error as Error).message}`);
    }
    // This command proves transactions itself, which needs the wallet's PXE —
    // a capability the Wallet interface does not promise. A conforming wallet
    // without it used to reach confirmation and then throw (round-18).
    // Captured, not just checked: `pxe` could itself be a getter handing the
    // capability check one object and the send another (round-19).
    type ProvingPxe = { proveTx: (r: unknown, o: unknown) => Promise<{ toTx: () => Promise<unknown> }> };
    const pxe = (wallet as unknown as { pxe?: Partial<ProvingPxe> }).pxe;
    if (typeof pxe?.proveTx !== 'function') {
      throw new CliUsageError(
        'measure needs a wallet exposing `pxe.proveTx` (it builds and proves the sponsored transactions itself). ' +
          'The wallet returned by your config module does not provide one.',
      );
    }
    const walletChain = await (wallet as unknown as { getChainInfo: () => Promise<never> }).getChainInfo();
    const walletChainInfo = walletChain as unknown as {
      chainId: { toString(): string };
      version: { toString(): string };
    };
    if (
      BigInt(walletChainInfo.chainId.toString()) !== BigInt(info.l1ChainId) ||
      BigInt(walletChainInfo.version.toString()) !== BigInt(info.rollupVersion)
    ) {
      throw new CliUsageError(
        `the config module's wallet is on chain ${walletChainInfo.chainId}/${walletChainInfo.version}, but its node ` +
          `reports ${info.l1ChainId}/${info.rollupVersion} — the plan would describe one chain and measure another`,
      );
    }

    // Declared before readQuotaInfo, which closes over it: the allowance
    // preflight below runs before any send, so this must already exist.
    let sent = 0;

    const readQuotaInfo = async (): Promise<{ hasAllowance: boolean; remaining: number }> => {
      const raw = await fpcContract.methods.get_quota_info(from, generation).simulate({ from });
      const unwrapped = (raw as { result?: unknown })?.result ?? raw;
      const [has, remaining] = unwrapped as [boolean, number | bigint];
      // Only an UNSUBSCRIBED player's first send reads as "no quota record
      // yet"; a subscribed player reporting no allowance has genuinely
      // exhausted the day. Without the subscription check, that player got a
      // full-allowance budget and then a sponsor_and_execute that the contract
      // rejects (round-7 finding 5) — and this matches the seat logic, which
      // was already conditioned on it.
      if (!has && sent === 0 && !alreadySubscribed) return { hasAllowance: true, remaining: maxUses };
      return { hasAllowance: Boolean(has), remaining: Number(remaining) };
    };

    // Refuse a count the allowance cannot cover BEFORE confirming it. The
    // library used to clamp silently after confirmation, so `--yes --count 3`
    // against an exhausted allowance printed a plan for 3 sends, sent ZERO,
    // and exited 0 — a confirmed plan under-delivering without saying so
    // (round-13).
    const preflight = await readQuotaInfo();
    const budget = preflight.hasAllowance ? preflight.remaining : 0;
    if (budget < count) {
      throw new CliUsageError(
        `the allowance permits ${budget} more sponsored send(s) for generation ${generation}, but --count ${count} ` +
          `was requested. Re-run with --count ${budget || 1} after the daily reset, or lower --count.`,
      );
    }

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
      player: from.toString().toLowerCase(),
      // The gas envelope determines what each send can cost, so it belongs in
      // what the operator confirms — and is snapshotted, since `ctx` is the
      // config module's own mutable object.
      gasProfileDigest: digestOptions({ ...gasProfile }),
      maxFeePerDaGas: maxFeePerDaGas.toString(),
      maxFeePerL2Gas: maxFeePerL2Gas.toString(),
      spendsRealFeeJuice: true,
    });
    if ((await makeConfirm(flags)(plan)) !== true) throw new ActionAborted(plan);

    const result = await measureSponsoredFee(
      {
        node: node,
        fpcAddress,
        sendSponsored: async () => {
          let seat: number | undefined;
          if (!alreadySubscribed && sent === 0) {
            const free = await findFreeSeat({ node: node as never, fpcAddress, generation, maxUsers });
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
          const payload = await buildSandwichPayload(
            { calls, player: from, fpcAddress, generation, seat },
            wallet as never,
            fpcContract as never,
          );
          // The whole CONFIRMED envelope, not just the totals: teardown limits
          // and the fee headroom are part of what the operator approved, and
          // letting the SDK invent its own would measure a different envelope
          // than the one on the plan.
          const gasSettings = GasSettings.fallback({
            gasLimits: new Gas(gasProfile.daGasLimit, gasProfile.l2GasLimit),
            teardownGasLimits: new Gas(gasProfile.teardownDaGasLimit, gasProfile.teardownL2GasLimit),
            maxFeesPerGas: confirmedMaxFees,
          });
          const request = await new DefaultEntrypoint().createTxExecutionRequest(payload, gasSettings, walletChain);
          const proven = await (pxe as ProvingPxe).proveTx(request, { scopes: [from] });
          const tx = await proven.toTx();
          // The plan was confirmed against a specific chain; re-read identity
          // immediately before the send so a swapped endpoint cannot receive it.
          const nowInfo = await node.getNodeInfo();
          if (nowInfo.l1ChainId !== info.l1ChainId || nowInfo.rollupVersion !== info.rollupVersion) {
            throw new ActionRevalidationFailed(plan, 'chain identity changed between confirmation and broadcast', sent);
          }
          await node.sendTx(tx as never);
          const receipt = await waitForTx(node, (tx as { getTxHash: () => never }).getTxHash());
          // Counted only once the transaction actually LANDED: incrementing at
          // payload-build time made the revalidation failure report one
          // transaction already sent before the first one existed, and N
          // instead of N-1 thereafter (round-16). It also drives the "first
          // send" seat selection and the inter-send wait, both of which want
          // the landed count.
          sent += 1;
          return { transactionFeeWei: BigInt((receipt as { transactionFee?: bigint })?.transactionFee ?? 0n) };
        },
        readQuotaInfo,
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
