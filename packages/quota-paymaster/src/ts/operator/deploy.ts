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
import { type ConfirmAction, confirmAndRevalidate, createActionPlan } from './action-plan.js';

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
    // Options affect fee/wait behavior — snapshot them too, so a confirm
    // callback cannot swap them after approval (round-2 finding 6).
    sendOptions: { ...opts.sendOptions },
  };

  const classId = await assertArtifactIsChainVerifiedClass();
  await verifyAccountClassIds(snapshot.accountClasses, opts.allowUnverifiedAccountClasses ?? false, deps.onWarn);

  const plan = createActionPlan('deploy-quota-fpc', {
    contractClassId: classId,
    deploymentName: snapshot.name,
    admin: snapshot.adminAddress,
    maxFeeWei: snapshot.policy.maxFeeWei,
    maxUsesPerDay: snapshot.policy.maxUsesPerDay,
    maxUsersPerDay: snapshot.policy.maxUsersPerDay,
    targets: snapshot.targets.map((t) => t.address).join(','),
    accountClasses: snapshot.accountClasses.map((c) => c.classId).join(','),
    requireUnpublishedAccounts: snapshot.requireUnpublishedAccounts,
    worstCasePerDayWei: worstCasePerDayWei(snapshot.policy).toString(),
    maxLossWei: snapshot.maxLossWei,
    from: snapshot.from.toString(),
  });
  // Deployment has no CAS to recheck; revalidation re-asserts the artifact so
  // a rebuild between confirm and send cannot swap the class underneath.
  await confirmAndRevalidate(plan, deps.confirm, async () => {
    const now = await getContractClassFromArtifact(QuotaFpcContractArtifact);
    return now.id.toString() === classId ? undefined : 'compiled artifact changed';
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
  // cannot be overridden by an unconfirmed option (finding #1).
  await deployment.send({ ...snapshot.sendOptions, from: snapshot.from });
  return await deployment.register();
}
