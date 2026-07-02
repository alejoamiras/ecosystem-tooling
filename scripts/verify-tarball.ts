#!/usr/bin/env bun
/**
 * Pre-publish tarball compatibility gate (plan D20/C1).
 *
 * For each package dir: `npm pack` the CURATED manifest, install the tarball into a
 * clean temp project WITH THE NPM CLIENT (not bun — bun masks postinstall breakage),
 * then import every legacy consumer surface with node. Fails loudly on any miss.
 *
 * Usage: bun scripts/verify-tarball.ts packages/aztec-benchmark packages/aztec-standards ...
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

type Check = { kind: 'import' | 'require' | 'file' | 'json'; spec: string };

const CHECKS: Record<string, Check[]> = {
  'aztec-benchmark': [
    { kind: 'import', spec: '@alejoamiras/aztec-benchmark' },
    { kind: 'require', spec: '@alejoamiras/aztec-benchmark/action/comparison.cjs' },
    { kind: 'file', spec: 'node_modules/@alejoamiras/aztec-benchmark/bin/aztec-benchmark' },
    { kind: 'file', spec: 'node_modules/@alejoamiras/aztec-benchmark/action/action.yml' },
  ],
  // Paths mirror the REAL legacy 4.2.0 tarball layout (verified 2026-07-01: nested
  // artifacts/src/artifacts/*.js — tsc widens rootDir because bindings import target/*.json).
  'aztec-standards': [
    { kind: 'import', spec: '@alejoamiras/aztec-standards/artifacts/src/artifacts/Token.js' },
    { kind: 'import', spec: '@alejoamiras/aztec-standards/dist/src/artifacts/Token.js' },
    { kind: 'json', spec: 'node_modules/@alejoamiras/aztec-standards/artifacts/target/token_contract-Token.json' },
    { kind: 'json', spec: 'node_modules/@alejoamiras/aztec-standards/target/token_contract-Token.json' },
    { kind: 'json', spec: 'node_modules/@alejoamiras/aztec-standards/deployments.json' },
    { kind: 'import', spec: '@alejoamiras/aztec-standards/artifacts/src/artifacts/Vault.js' },
  ],
  'aztec-fee-payment': [
    { kind: 'import', spec: '@alejoamiras/aztec-fee-payment' },
    { kind: 'import', spec: '@alejoamiras/aztec-fee-payment/fee-payment-methods' },
    { kind: 'import', spec: '@alejoamiras/aztec-fee-payment/utils' },
    { kind: 'import', spec: '@alejoamiras/aztec-fee-payment/artifacts/private' },
    { kind: 'json', spec: 'node_modules/@alejoamiras/aztec-fee-payment/target/private_contract-PrivateFPC.json' },
  ],
};

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim();

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
        if (check.kind === 'import') {
          execFileSync('node', ['--input-type=module', '-e', `await import(${JSON.stringify(check.spec)});`], {
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
