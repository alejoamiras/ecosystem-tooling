/**
 * The published CLI against a live network, driven the way an operator drives
 * it: a config module on disk, an explicit --config-module path, and --yes.
 *
 * Runs the CLI from SOURCE (`bun src/ts/cli/main.ts`) because CI runs vitest
 * before the dist build; the COMPILED launcher is proven separately by the
 * clean-room tarball probe, which installs the built package and runs its
 * .bin shim.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FpcTestTargetContract } from '../../../artifacts/FpcTestTarget.js';
import type { QuotaFpcContract } from '../../../artifacts/QuotaFpc.js';
import { type Ctx, connect, evidence, fundWithFeeJuice, NODE_URL } from '../harness.js';
import { deployOwnFpc } from '../suite-helpers.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = join(PKG_ROOT, 'src/ts/cli/main.ts');

const cleanups: (() => void)[] = [];
afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
});

interface CliResult {
  status: number;
  out: string;
}

function cli(args: string[]): CliResult {
  try {
    const out = execFileSync('bun', [CLI, ...args], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_URL },
    });
    return { status: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('published CLI (live network)', () => {
  let ctx: Ctx;
  let fpc: QuotaFpcContract;
  let target: FpcTestTargetContract;
  let configModulePath: string;

  beforeAll(async () => {
    ctx = await connect();
    const player = ctx.addresses[0];

    const targetDeploy = FpcTestTargetContract.deploy(ctx.wallet);
    await targetDeploy.send({ from: player });
    target = await targetDeploy.register();
    fpc = await deployOwnFpc(ctx, target, player);
    await fundWithFeeJuice(ctx.node, ctx.wallet, fpc.address, 10n ** 21n, player, () =>
      target.methods.ping().send({ from: player }),
    );

    // A real config module: the same shape an operator writes, using this
    // network's pre-registered accounts instead of env-supplied keys.
    //
    // It lives INSIDE the package, not in the OS temp dir, because a config
    // module's own bare imports (@aztec/*) resolve from the CONFIG'S location
    // — the split-resolution the Phase-1 spike documented. A config in /tmp
    // resolves against the global cache and fails; an operator's real config
    // sits in their project, where its deps resolve. The test must model that.
    const dir = mkdtempSync(join(PKG_ROOT, '.tmp-cli-it-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    configModulePath = join(dir, 'live.config.mjs');
    writeFileSync(
      configModulePath,
      `import { defineOperatorConfig } from '${join(PKG_ROOT, 'src/ts/operator/config.ts')}';\n` +
        `export default defineOperatorConfig(async () => {\n` +
        `  const { createAztecNodeClient, waitForNode } = await import('@aztec/aztec.js/node');\n` +
        `  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');\n` +
        `  const { registerInitialLocalNetworkAccountsInWallet } = await import('@aztec/wallets/testing');\n` +
        `  const node = createAztecNodeClient(${JSON.stringify(NODE_URL)});\n` +
        `  await waitForNode(node);\n` +
        `  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });\n` +
        `  const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);\n` +
        `  return { node, wallet, from: accounts[0],\n` +
        `    gasProfile: { daGasLimit: 50000, l2GasLimit: 6000000, teardownDaGasLimit: 5000,\n` +
        `      teardownL2GasLimit: 500000, feeHeadroomMultiplier: 1.5 },\n` +
        `    dispose: () => wallet.stop() };\n` +
        `});\n`,
    );
  }, 600_000);

  test('policy --show reads live state through a config module', () => {
    const result = cli(['policy', '--fpc', fpc.address.toString(), '--config-module', configModulePath, '--show']);
    evidence('cli/policy-show', result.out.slice(0, 400));
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/Paymaster 0x/);
    expect(result.out).toMatch(/live policy/);
    expect(result.out).toMatch(/reserve/);
  }, 300_000);

  test('a policy edit WITHOUT --yes prints the plan and changes nothing', () => {
    const before = cli(['policy', '--fpc', fpc.address.toString(), '--config-module', configModulePath, '--show']).out;
    const dry = cli([
      'policy',
      '--fpc',
      fpc.address.toString(),
      '--config-module',
      configModulePath,
      '--max-uses',
      '3',
      // Must cover worst case = 3 x maxFee x maxUses x maxUsers for the LIVE
      // policy; too small and the library refuses the edit (correctly) before
      // ever building a plan.
      '--max-loss-wei',
      '1000000000000000000000000',
    ]);
    evidence('cli/policy-dry-run', dry.out.slice(0, 400));
    // Refused, with the plan and its digest shown.
    expect(dry.status).toBe(2);
    expect(dry.out).toMatch(/Action plan: schedule-policy-change/);
    expect(dry.out).toMatch(/digest\s+[0-9a-f]{64}/);
    expect(dry.out).toMatch(/Dry run: nothing was sent/);

    const after = cli(['policy', '--fpc', fpc.address.toString(), '--config-module', configModulePath, '--show']).out;
    // The scheduled revision line is the thing an edit would move.
    const revision = (text: string) => text.match(/scheduled\s+rev (\d+)/)?.[1];
    expect(revision(after)).toBe(revision(before));
  }, 300_000);

  test('the same inputs produce the same plan digest (stability)', () => {
    const args = [
      'policy',
      '--fpc',
      fpc.address.toString(),
      '--config-module',
      configModulePath,
      '--max-uses',
      '4',
      // Must cover worst case = 3 x maxFee x maxUses x maxUsers for the LIVE
      // policy; too small and the library refuses the edit (correctly) before
      // ever building a plan.
      '--max-loss-wei',
      '1000000000000000000000000',
    ];
    const first = cli(args).out.match(/digest\s+([0-9a-f]{64})/)?.[1];
    const second = cli(args).out.match(/digest\s+([0-9a-f]{64})/)?.[1];
    expect(first).toBeDefined();
    expect(second).toBe(first);
  }, 300_000);

  test('deploy runs end to end through the bin and a config module', async () => {
    // The class id must be the REAL one from the installed @aztec/accounts:
    // for a KNOWN class name a mismatched id always refuses (and should —
    // it would ship an allowlist that rejects every real account).
    // --allow-unverified-account-classes only covers UNKNOWN names.
    const { getContractClassFromArtifact } = await import('@aztec/aztec.js/contracts');
    const { SchnorrInitializerlessAccountContractArtifact } = await import('@aztec/accounts/schnorr');
    const classId = (await getContractClassFromArtifact(SchnorrInitializerlessAccountContractArtifact)).id.toString();

    const configPath = join(dirname(configModulePath), 'deploy.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'cli-integration',
        policy: { maxFeeWei: '100000000000000000000', maxUsesPerDay: 5, maxUsersPerDay: 20 },
        allowedTargets: [{ name: 'T', address: ctx.addresses[0].toString() }],
        allowedAccountClasses: [{ name: 'SchnorrInitializerlessAccount', classId }],
        requireUnpublishedAccounts: true,
        adminAddress: ctx.addresses[0].toString(),
        maxLossWei: '1000000000000000000000000',
      }),
    );
    const result = cli(['deploy', '--config', configPath, '--config-module', configModulePath, '--yes']);
    evidence('cli/deploy', result.out.slice(-400));
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/QUOTA_FPC_CONTRACT_ADDRESS=0x[0-9a-f]{64}/i);
    expect(result.out).toMatch(/Fund LAST/);
  }, 600_000);

  test('measure spends real quota and reports two agreeing accountings', () => {
    // This command was a stub until Phase 2 and had NO live coverage, which is
    // why an unregistered-artifact bug (fatal on the first read) survived a
    // whole review round. It sends real sponsored transactions, so it is
    // --yes-gated like every other state-changing command.
    // The COMPILED artifact on disk — exactly what an operator passes.
    const artifactPath = join(PKG_ROOT, 'target/fpc_test_target-FpcTestTarget.json');

    const result = cli([
      'measure',
      '--fpc',
      fpc.address.toString(),
      '--target',
      target.address.toString(),
      '--artifact',
      artifactPath,
      '--method',
      'record',
      '--count',
      '1',
      '--config-module',
      configModulePath,
      '--yes',
    ]);
    evidence('cli/measure', result.out.slice(-500));
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/Measured 1 sponsored transaction/);
    // The two independent accountings the operator library cross-checks.
    expect(result.out).toMatch(/total \(receipts\)/);
    expect(result.out).toMatch(/balance delta/);
    expect(result.out).not.toMatch(/accountings disagree/);
  }, 900_000);

  test('measure WITHOUT --yes prints the plan (with the gas envelope) and sends nothing', () => {
    const artifactPath = join(PKG_ROOT, 'target/fpc_test_target-FpcTestTarget.json');
    const dry = cli([
      'measure',
      '--fpc',
      fpc.address.toString(),
      '--target',
      target.address.toString(),
      '--artifact',
      artifactPath,
      '--count',
      '1',
      '--config-module',
      configModulePath,
    ]);
    expect(dry.status).toBe(2);
    expect(dry.out).toMatch(/Action plan: measure-sponsored-fee/);
    expect(dry.out).toMatch(/gasProfileDigest/);
    expect(dry.out).toMatch(/spendsRealFeeJuice/);
    expect(dry.out).toMatch(/Dry run: nothing was sent/);
  }, 300_000);
});
