/**
 * Shared helpers for the integration and warp suites. Kept out of the test
 * files so both suites drive the contract through IDENTICAL code paths.
 */
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { FpcTestTargetContract } from '../../artifacts/FpcTestTarget.js';
import { QuotaFpcContract } from '../../artifacts/QuotaFpc.js';
import { buildSandwichPayload } from '../sandwich.js';
import { type Ctx, sendFromPaymaster } from './harness.js';

export const ZERO = AztecAddress.fromStringUnsafe(`0x${'0'.repeat(64)}`);
export const MAX_FEE = 10n ** 20n;
export const MAX_USES = 3;
export const MAX_USERS = 40;

/**
 * The harness accounts are schnorr_initializerless — the same class the
 * embedded wallet deploys in production — so allowlisting it proves the REAL
 * positive path. Computed from the installed artifact rather than hardcoded,
 * exactly as the deploy library does, so an @aztec/accounts bump cannot
 * silently break the suite.
 */
export async function initializerlessClassId(): Promise<bigint> {
  const { getContractClassFromArtifact } = await import('@aztec/aztec.js/contracts');
  const { SchnorrInitializerlessAccountContractArtifact } = await import('@aztec/accounts/schnorr');
  const { id } = await getContractClassFromArtifact(SchnorrInitializerlessAccountContractArtifact);
  return id.toBigInt();
}

// biome-ignore lint/suspicious/noExplicitAny: simulate() results are version-loose
export const unwrap = (raw: any) => raw?.result ?? raw;

/** Reads the live bundle and returns it with the named fields overridden. */
export async function bundleFrom(
  fpc: QuotaFpcContract,
  overrides: { maxFeeWei?: bigint; maxUses?: number; maxUsers?: number; targets?: AztecAddress[] },
) {
  const from = fpc.address;
  const policy = unwrap(await fpc.methods.get_policy().simulate({ from }));
  const targets = unwrap(await fpc.methods.get_allowed_targets().simulate({ from }));
  const pad = (list: AztecAddress[]) => [...list, ...Array(12 - list.length).fill(ZERO)];
  return {
    max_fee: overrides.maxFeeWei ?? BigInt(policy.max_fee ?? policy[0]),
    max_uses: overrides.maxUses ?? Number(policy.max_uses ?? policy[1]),
    max_users: overrides.maxUsers ?? Number(policy.max_users ?? policy[2]),
    allowed_targets: overrides.targets ? pad(overrides.targets) : targets,
  };
}

export async function currentRevision(fpc: QuotaFpcContract, from: AztecAddress): Promise<bigint> {
  const raw = unwrap(await fpc.methods.get_scheduled_settings().simulate({ from }));
  const [, , revision] = raw;
  return BigInt(revision);
}

export async function allowanceOf(fpc: QuotaFpcContract, who: AztecAddress, gen: number) {
  const raw = unwrap(await fpc.methods.get_quota_info(who, gen).simulate({ from: who }));
  const [subscribed, remaining] = raw;
  return { subscribed: Boolean(subscribed), remaining: Number(remaining) };
}

// biome-ignore lint/suspicious/noExplicitAny: contract interaction shapes are version-loose
export const callsOf = async (interaction: any) => {
  const payload = await interaction.request();
  return payload.calls ?? payload;
};

/** Waits until a just-deployed instance's PublicImmutables are anchored. */
export async function awaitPolicyReadable(fpc: QuotaFpcContract, from: AztecAddress) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await fpc.methods.get_policy().simulate({ from });
      return fpc;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

export interface Suite {
  ctx: Ctx;
  fpc: QuotaFpcContract;
  target: FpcTestTargetContract;
  generationOf: () => number;
}

/** Assembles and sends a sponsored transaction through the package's own code. */
export async function sponsorVia(
  suite: Suite,
  // biome-ignore lint/suspicious/noExplicitAny: FunctionCall arrays from interactions
  calls: any[],
  from: AztecAddress,
  opts: { seat?: number; generation?: number; fpc?: QuotaFpcContract } = {},
) {
  const fpc = opts.fpc ?? suite.fpc;
  const payload = await buildSandwichPayload(
    {
      calls,
      player: from,
      fpcAddress: fpc.address,
      generation: opts.generation ?? suite.generationOf(),
      seat: opts.seat,
    },
    suite.ctx.wallet,
    // biome-ignore lint/suspicious/noExplicitAny: the generated contract satisfies QuotaFpcMethods structurally
    fpc as any,
  );
  return sendFromPaymaster(suite.ctx, payload, from);
}

/**
 * A paymaster of a test's own, for cases that mutate policy or warp the chain.
 */
export async function deployOwnFpc(
  ctx: Ctx,
  target: FpcTestTargetContract,
  admin: AztecAddress,
  overrides: { maxUses?: number; maxFeeWei?: bigint } = {},
): Promise<QuotaFpcContract> {
  const deploy = QuotaFpcContract.deploy(
    ctx.wallet,
    admin,
    overrides.maxFeeWei ?? MAX_FEE,
    overrides.maxUses ?? MAX_USES,
    MAX_USERS,
    [target.address, ...Array(11).fill(ZERO)],
    [await initializerlessClassId(), 0n, 0n, 0n],
    true,
  );
  await deploy.send({ from: admin });
  const instance = await deploy.register();
  return awaitPolicyReadable(instance, admin);
}
