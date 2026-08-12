/**
 * Deploys a QuotaFpc paymaster from a validated config.
 *
 * Deploying does NOT fund. Funding is a separate, deliberate step (fund LAST:
 * deploy → verify the tooling drives the instance → audit → canary → tranche),
 * because fee juice sent to the paymaster can never be recovered.
 */
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractClassFromArtifact } from '@aztec/aztec.js/contracts';
import type { Wallet } from '@aztec/aztec.js/wallet';
import knownDeployments from '../../../known-deployments.json' with { type: 'json' };
import { QuotaFpcContract, QuotaFpcContractArtifact } from '../../artifacts/QuotaFpc.js';
import {
  padAllowedAccountClasses,
  padAllowedTargets,
  type parseQuotaFpcConfig,
  worstCasePerDayWei,
} from '../config/schema.js';
import {
  type ConfirmAction,
  confirmAndRevalidate,
  createActionPlan,
  digestOptions,
  snapshotOptions,
} from './action-plan.js';

export type ParsedQuotaFpcConfig = ReturnType<typeof parseQuotaFpcConfig>;

/**
 * Class ids are hashes of the account artifacts, pinned to the installed
 * `@aztec/accounts` version. A config carrying ids from a different version
 * would deploy an immutable allowlist that matches NO real account — every
 * sponsorship attempt would fail — so recompute and refuse on any mismatch.
 * Known upstream classes are checked by name; an unrecognized name FAILS
 * unless `allowUnverified` is passed, so a typo cannot quietly ship an
 * unchecked id.
 */
export async function verifyAccountClassIds(
  classes: { name: string; classId: string }[],
  allowUnverified = false,
  onWarn: (msg: string) => void = () => {},
): Promise<{ verified: number; unverified: number }> {
  const { SchnorrAccountContractArtifact, SchnorrInitializerlessAccountContractArtifact } = await import(
    '@aztec/accounts/schnorr'
  );

  // Two unrelated artifact hashes — non-trivial CPU work, computed in parallel.
  const entries = await Promise.all(
    (
      [
        ['SchnorrAccount', SchnorrAccountContractArtifact],
        ['SchnorrInitializerlessAccount', SchnorrInitializerlessAccountContractArtifact],
      ] as const
    ).map(async ([name, artifact]) => [name, (await getContractClassFromArtifact(artifact)).id.toBigInt()] as const),
  );
  const known = new Map<string, bigint>(entries);

  let verified = 0;
  let unverified = 0;
  for (const entry of classes) {
    const expected = known.get(entry.name.trim());
    if (expected === undefined) {
      // Fail closed. A typo ("SchnorrInitializerlesAccount") would otherwise
      // ship an unverified id behind a warning nobody reads — bricking
      // sponsorship at best, blessing hostile code at worst.
      if (!allowUnverified) {
        throw new Error(
          `Cannot verify account class "${entry.name}": not one this library knows ` +
            `(${[...known.keys()].join(', ')}). Fix the name, or pass allowUnverified ` +
            `to ship its id unchecked on purpose.`,
        );
      }
      onWarn(`${entry.name} ships UNVERIFIED (allowUnverified).`);
      unverified += 1;
      continue;
    }
    if (BigInt(entry.classId) !== expected) {
      throw new Error(
        `Config classId for ${entry.name} (${entry.classId}) does not match the installed ` +
          `@aztec/accounts artifact (0x${expected.toString(16).padStart(64, '0')}). ` +
          `The config is pinned to a different version — update it, or deploy from the matching checkout. ` +
          `Deploying anyway would ship an immutable allowlist that rejects every real account.`,
      );
    }
    verified += 1;
  }
  return { verified, unverified };
}

/** Lineage guard: refuse to deploy an artifact that is not the chain-verified class. */
export async function assertArtifactIsChainVerifiedClass(): Promise<string> {
  const { id } = await getContractClassFromArtifact(QuotaFpcContractArtifact);
  const expected = knownDeployments.mainnet.classId;
  if (id.toString() !== expected) {
    throw new Error(
      `The compiled QuotaFpc artifact's class id ${id} does not match the chain-verified ` +
        `lineage class ${expected}. Rebuild from clean sources (verify:lineage) before deploying.`,
    );
  }
  return id.toString();
}

export interface DeployQuotaFpcDeps {
  /** The deploying wallet (fees already arranged by the caller). */
  wallet: Wallet;
  /** Address the deployment is sent from. */
  from: AztecAddress;
  confirm: ConfirmAction;
  onWarn?: (msg: string) => void;
}

export interface DeployQuotaFpcOptions {
  allowUnverifiedAccountClasses?: boolean;
  /** Extra fields merged into the send options (fee payment etc.). */
  sendOptions?: Record<string, unknown>;
}

/** Deploys from a config already validated by parseQuotaFpcConfig. */
export async function deployQuotaFpc(
  deps: DeployQuotaFpcDeps,
  config: ParsedQuotaFpcConfig,
  opts: DeployQuotaFpcOptions = {},
): Promise<QuotaFpcContract> {
  // Snapshot every execution input BEFORE verifying or confirming — including
  // COPIES of the arrays. `config` is caller-owned; a confirmation callback
  // mutating it after the digest was shown would deploy something other than
  // what was verified and approved (post-impl audit finding #1). Everything
  // below uses only this snapshot.
  const snapshot = {
    name: config.name,
    adminAddress: config.adminAddress,
    policy: { ...config.policy },
    targets: config.resolvedTargets.map((t) => ({ ...t })),
    accountClasses: config.resolvedAccountClasses.map((c) => ({ ...c })),
    requireUnpublishedAccounts: config.requireUnpublishedAccounts,
    maxLossWei: config.maxLossWei,
    from: deps.from,
    // Options affect fee/wait behavior — snapshot them too (recursively for
    // plain objects), so a confirm callback cannot swap them after approval
    // (round-2 finding 6; round-3 finding 4).
    sendOptions: snapshotOptions(opts.sendOptions ?? {}),
  };

  const classId = await assertArtifactIsChainVerifiedClass();
  await verifyAccountClassIds(snapshot.accountClasses, opts.allowUnverifiedAccountClasses ?? false, deps.onWarn);

  // WHICH CHAIN. Every sibling plan binds this; deploy bound none, so a dry
  // run against a testnet NODE_URL and a --yes run against mainnet produced a
  // byte-identical digest and the same confirm characters (round-9 finding 2).
  const chain = await deps.wallet.getChainInfo();
  // The EFFECTIVE options, computed before the plan so the digest covers what
  // actually executes rather than what was requested (round-12). The import
  // stays inside the function — laziness preserved, just earlier.
  const { TxStatus } = await import('@aztec/stdlib/tx');
  const FINALITY_ORDER = [TxStatus.PROPOSED, TxStatus.CHECKPOINTED, TxStatus.PROVEN, TxStatus.FINALIZED];
  const { wait: callerWait, ...sendOpts } = snapshot.sendOptions;
  const callerWaitObj = callerWait && typeof callerWait === 'object' ? (callerWait as Record<string, unknown>) : {};
  const requestedStatus = callerWaitObj.waitForStatus as (typeof FINALITY_ORDER)[number] | undefined;
  const waitForStatus =
    requestedStatus !== undefined &&
    FINALITY_ORDER.indexOf(requestedStatus) > FINALITY_ORDER.indexOf(TxStatus.CHECKPOINTED)
      ? requestedStatus
      : TxStatus.CHECKPOINTED;
  const effectiveSendOptions = {
    ...sendOpts,
    from: snapshot.from,
    wait: { ...callerWaitObj, waitForStatus, dontThrowOnRevert: false },
  };

  const plan = createActionPlan('deploy-quota-fpc', {
    l1ChainId: chain.chainId.toString(),
    rollupVersion: chain.version.toString(),
    contractClassId: classId,
    deploymentName: snapshot.name,
    // Canonical forms: the SAME deployment written with an uppercase address
    // or a hex amount produced a different digest, so a rehearsed digest and
    // the real one disagreed over nothing (round-17).
    admin: snapshot.adminAddress.toLowerCase(),
    maxFeeWei: BigInt(snapshot.policy.maxFeeWei).toString(),
    maxUsesPerDay: snapshot.policy.maxUsesPerDay,
    maxUsersPerDay: snapshot.policy.maxUsersPerDay,
    targets: snapshot.targets.map((t) => t.address.toLowerCase()).join(','),
    accountClasses: snapshot.accountClasses.map((c) => BigInt(c.classId).toString()).join(','),
    requireUnpublishedAccounts: snapshot.requireUnpublishedAccounts,
    worstCasePerDayWei: worstCasePerDayWei(snapshot.policy).toString(),
    maxLossWei: BigInt(snapshot.maxLossWei).toString(),
    from: snapshot.from.toString(),
    // Binds option VALUES, not just names: plain parts by canonical value,
    // class instances by constructor name (round-3 finding 4; round-4
    // finding 2 — same-class internal state is the documented residual).
    sendOptionsDigest: digestOptions(effectiveSendOptions),
  });
  // Deployment has no CAS to recheck; revalidation re-asserts the artifact so
  // a rebuild between confirm and send cannot swap the class underneath.
  await confirmAndRevalidate(plan, deps.confirm, async () => {
    const now = await getContractClassFromArtifact(QuotaFpcContractArtifact);
    if (now.id.toString() !== classId) return 'compiled artifact changed';
    const nowChain = await deps.wallet.getChainInfo();
    return nowChain.chainId.toString() === chain.chainId.toString() &&
      nowChain.version.toString() === chain.version.toString()
      ? undefined
      : 'chain identity changed between confirmation and deployment';
  });

  const allowed = padAllowedTargets(snapshot.targets.map((t) => t.address)).map((a) =>
    AztecAddress.fromStringUnsafe(a),
  );
  const allowedClasses = padAllowedAccountClasses(snapshot.accountClasses.map((c) => BigInt(c.classId)));

  const deployment = QuotaFpcContract.deploy(
    deps.wallet,
    AztecAddress.fromStringUnsafe(snapshot.adminAddress),
    BigInt(snapshot.policy.maxFeeWei),
    snapshot.policy.maxUsesPerDay,
    snapshot.policy.maxUsersPerDay,
    allowed,
    allowedClasses,
    snapshot.requireUnpublishedAccounts,
  );
  // The SNAPSHOTTED options spread FIRST: the confirmed sender is bound and
  // cannot be overridden by an unconfirmed option (finding #1). The wait is
  // floored at CHECKPOINTED finality before success is declared — the wallet
  // default (PROPOSED) can be reorged out after this returns (round-5
  // finding 1, applied to deploy as well as policy). Callers may request
  // stronger finality via sendOptions.wait; weaker is overridden.
  const { receipt } = await deployment.send(effectiveSendOptions);
  if (!receipt.isMined() || !receipt.hasExecutionSucceeded()) {
    throw new Error(`deployment transaction ${receipt.txHash} did not execute successfully (status ${receipt.status})`);
  }
  return await deployment.register();
}
