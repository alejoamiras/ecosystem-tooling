#!/usr/bin/env bun
/**
 * Pre-publish tarball compatibility gate (plan D20/C1).
 *
 * For each package dir: `npm pack` the CURATED manifest, install the tarball into a
 * clean temp project WITH THE NPM CLIENT (not bun — bun masks postinstall breakage),
 * then import every legacy consumer surface with node. Fails loudly on any miss.
 *
 * Usage: bun scripts/verify-tarball.ts packages/aztec-benchmark packages/private-fee-juice ...
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

type Check =
  | { kind: 'import' | 'require' | 'file' | 'json' | 'absent-dir'; spec: string }
  | { kind: 'absent-match'; spec: string; pattern: RegExp }
  | { kind: 'exec'; spec: string; script: string };

const CHECKS: Record<string, Check[]> = {
  'aztec-benchmark': [
    { kind: 'import', spec: '@alejoamiras/aztec-benchmark' },
    { kind: 'require', spec: '@alejoamiras/aztec-benchmark/action/comparison.cjs' },
    { kind: 'file', spec: 'node_modules/@alejoamiras/aztec-benchmark/bin/aztec-benchmark' },
    { kind: 'file', spec: 'node_modules/@alejoamiras/aztec-benchmark/action/action.yml' },
  ],
  'private-fee-juice': [
    { kind: 'import', spec: '@alejoamiras/private-fee-juice' },
    { kind: 'import', spec: '@alejoamiras/private-fee-juice/fee-payment-methods' },
    { kind: 'import', spec: '@alejoamiras/private-fee-juice/utils' },
    { kind: 'import', spec: '@alejoamiras/private-fee-juice/artifacts/private' },
    { kind: 'json', spec: 'node_modules/@alejoamiras/private-fee-juice/target/private_contract-PrivateFPC.json' },
    { kind: 'json', spec: 'node_modules/@alejoamiras/private-fee-juice/canonical-deployment.json' },
  ],
  'quota-paymaster': [
    { kind: 'import', spec: '@alejoamiras/quota-paymaster' },
    { kind: 'import', spec: '@alejoamiras/quota-paymaster/operator' },
    { kind: 'import', spec: '@alejoamiras/quota-paymaster/operator/config' },
    { kind: 'import', spec: '@alejoamiras/quota-paymaster/artifacts/quota-fpc' },
    { kind: 'file', spec: 'node_modules/@alejoamiras/quota-paymaster/bin/quota-paymaster.mjs' },
    { kind: 'file', spec: 'node_modules/.bin/quota-paymaster' },
    { kind: 'json', spec: 'node_modules/@alejoamiras/quota-paymaster/target/quota_fpc-QuotaFpc.json' },
    { kind: 'json', spec: 'node_modules/@alejoamiras/quota-paymaster/known-deployments.json' },
    // The consumer integration guide is a SHIPPED surface: the README links it
    // relatively, so a tarball without it gives every npm reader a dead link.
    { kind: 'file', spec: 'node_modules/@alejoamiras/quota-paymaster/INTEGRATING.md' },
    {
      // The SDK loads its cryptography LAZILY (dynamic import of @aztec/stdlib/hash inside
      // seat-picker) — a tarball missing that runtime dep passes a plain root-import check
      // green and explodes at first real use. EXECUTE a lazy path in the clean room.
      kind: 'exec',
      spec: 'lazy path: hasSubscribed → dynamic @aztec/stdlib/hash',
      script: `
        import { hasSubscribed } from '@alejoamiras/quota-paymaster';
        import { AztecAddress } from '@aztec/stdlib/aztec-address';
        const addr = AztecAddress.fromStringUnsafe('0x' + '1'.repeat(64));
        const node = { findLeavesIndexes: async () => [undefined] };
        const result = await hasSubscribed({ node, fpcAddress: addr, generation: 1, player: addr });
        if (result !== false) throw new Error('unexpected result ' + result);
      `,
    },
    {
      // Same rationale for the OPERATOR entry's lazy paths (post-impl audit
      // finding #10: only probing the stdlib path leaves the other lazy peers
      // unexercised). verifyAccountClassIds dynamically imports
      // @aztec/accounts/schnorr and hashes its artifacts — CPU-only.
      kind: 'exec',
      spec: 'lazy path: verifyAccountClassIds → dynamic @aztec/accounts/schnorr',
      script: `
        import { verifyAccountClassIds } from '@alejoamiras/quota-paymaster/operator';
        const r = await verifyAccountClassIds([]);
        if (r.verified !== 0 || r.unverified !== 0) throw new Error('unexpected ' + JSON.stringify(r));
      `,
    },
    {
      // The bridge/claim paths lazily import these exact specifiers only after
      // a confirmed plan — too late to discover a missing peer. Prove they
      // resolve in the clean-room consumer install.
      kind: 'exec',
      spec: 'lazy deps resolvable: @aztec/ethereum, @aztec/l1-artifacts, @aztec/aztec.js/ethereum, @aztec/entrypoints',
      script: `
        await import('@aztec/ethereum/utils');
        await import('@aztec/l1-artifacts/FeeJuicePortalAbi');
        await import('@aztec/aztec.js/ethereum');
        await import('@aztec/entrypoints/encoding');
      `,
    },
    {
      // The bin is the product for operators: prove the INSTALLED shim resolves
      // and runs its compiled entry, not just that the file shipped. --help must
      // work with no config, no network and no optional deps.
      kind: 'exec',
      spec: 'installed bin: node_modules/.bin/quota-paymaster --help runs',
      script: `
        import { execFileSync } from 'node:child_process';
        const out = execFileSync('./node_modules/.bin/quota-paymaster', ['--help'], { encoding: 'utf8' });
        if (!/@alejoamiras\\/quota-paymaster/.test(out)) throw new Error('unexpected help output: ' + out);
        if (/npx quota-paymaster\\b/.test(out)) throw new Error('help advertises the UNSCOPED npx name');
      `,
    },
    {
      // A .mjs config must load with NO loader present — that is the whole
      // point of tsx being optional. (tsx is absent in this clean room.)
      kind: 'exec',
      spec: 'config module: .mjs loads with tsx ABSENT',
      script: `
        import { writeFileSync } from 'node:fs';
        import { loadOperatorConfigModule, resolveOperatorContext } from '@alejoamiras/quota-paymaster/operator/config';
        writeFileSync('probe.config.mjs',
          "import { defineOperatorConfig } from '@alejoamiras/quota-paymaster/operator/config';\\n" +
          "export default defineOperatorConfig(async () => ({ node: {}, wallet: {}, from: { toString: () => '0x1' } }));\\n");
        const mod = await loadOperatorConfigModule(new URL('probe.config.mjs', 'file://' + process.cwd() + '/').pathname);
        const ctx = await resolveOperatorContext(mod);
        if (ctx.from.toString() !== '0x1') throw new Error('config did not resolve');
        try {
          await import('tsx/esm/api');
          throw new Error('tsx unexpectedly present — this probe must run without it');
        } catch (e) {
          if (!/Cannot find|ERR_MODULE_NOT_FOUND/.test(String(e))) throw e;
        }
      `,
    },
    { kind: 'absent-dir', spec: 'dist/src/ts/test' },
    { kind: 'absent-dir', spec: 'scripts' },
    { kind: 'absent-dir', spec: 'examples' },
    {
      // Declaration maps point at ../src paths the tarball does not ship —
      // dead references at best, layout leakage at worst (post-impl audit
      // finding #10). The build config disables them; this stops a regression.
      kind: 'absent-match',
      spec: 'no source/declaration maps in the tarball',
      pattern: /\.(?:d\.ts|js)\.map$/,
    },
  ],
};

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim();

// Zero args used to print "all surfaces OK" having checked nothing (audit finding: vacuous
// gate). A verification script with no work is a misconfigured invocation, not a pass.
if (process.argv.length <= 2) {
  console.error('verify-tarball: no package directories given — refusing to report success on zero checks');
  process.exit(1);
}

let failures = 0;

for (const pkgDirArg of process.argv.slice(2)) {
  const pkgDir = resolve(pkgDirArg);
  const pkgName = basename(pkgDir);
  const checks = CHECKS[pkgName];
  if (!checks) {
    console.error(`No checks defined for ${pkgName}`);
    failures++;
    continue;
  }

  console.log(`\n=== ${pkgName}: pack + clean-room npm install ===`);
  const packJson = JSON.parse(run('npm', ['pack', '--json'], pkgDir));
  const tarball = join(pkgDir, packJson[0].filename);

  const tarEntries = run('tar', ['tzf', tarball], pkgDir).split('\n');

  // No stray build debris in published artifacts (e.g. aztec inspect-contract *.bak backups).
  const debris = tarEntries.filter(
    (f) => f.endsWith('.bak') || f.endsWith('.tsbuildinfo') || f.includes('codegenCache'),
  );
  if (debris.length > 0) {
    console.error(`  ✗ tarball contains build debris:\n    ${debris.join('\n    ')}`);
    failures++;
  } else {
    console.log('  ✓ tarball free of build debris');
  }

  const tmp = mkdtempSync(join(tmpdir(), `verify-${pkgName}-`));
  try {
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({ name: 'verify-consumer', private: true, type: 'module' }),
    );
    // npm (NOT bun): peers auto-install, postinstall scripts run — consumer-realistic.
    run('npm', ['install', tarball, '--no-audit', '--no-fund', '--loglevel=error'], tmp);

    for (const check of checks) {
      try {
        if (check.kind === 'absent-dir') {
          const present = tarEntries.filter((f) => f.startsWith(`package/${check.spec}`));
          if (present.length > 0) {
            throw new Error(
              `${present.length} tarball entries under ${check.spec} (expected none), e.g. ${present[0]}`,
            );
          }
        } else if (check.kind === 'absent-match') {
          const present = tarEntries.filter((f) => check.pattern.test(f));
          if (present.length > 0) {
            throw new Error(
              `${present.length} tarball entries match ${check.pattern} (expected none), e.g. ${present[0]}`,
            );
          }
        } else if (check.kind === 'import') {
          execFileSync('node', ['--input-type=module', '-e', `await import(${JSON.stringify(check.spec)});`], {
            cwd: tmp,
            stdio: ['ignore', 'ignore', 'pipe'],
          });
        } else if (check.kind === 'exec') {
          execFileSync('node', ['--input-type=module', '-e', check.script], {
            cwd: tmp,
            stdio: ['ignore', 'ignore', 'pipe'],
          });
        } else if (check.kind === 'require') {
          execFileSync('node', ['-e', `require(${JSON.stringify(check.spec)});`], {
            cwd: tmp,
            stdio: ['ignore', 'ignore', 'pipe'],
          });
        } else if (check.kind === 'file') {
          readFileSync(join(tmp, check.spec));
        } else {
          JSON.parse(readFileSync(join(tmp, check.spec), 'utf8'));
        }
        console.log(`  ✓ ${check.kind}: ${check.spec}`);
      } catch (err) {
        console.error(`  ✗ ${check.kind}: ${check.spec}\n    ${(err as Error).message.split('\n')[0]}`);
        failures++;
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tarball, { force: true });
  }
}

if (failures > 0) {
  console.error(`\nverify-tarball: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nverify-tarball: all surfaces OK');
