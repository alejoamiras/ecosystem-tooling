#!/usr/bin/env bun
/**
 * F-004 packaging gate — a REAL assertion, not an eyeballed `npm pack --dry-run`.
 *
 * `npm pack --dry-run` exits 0 even when forbidden files are present, so this script
 * parses the pack manifest and FAILS if the test-only Counter artifact/binding or the
 * deleted artifactRegistry leak into the tarball — through EITHER path (the root
 * `target/…Counter.json` copy AND the `dist/target/…Counter.json` copy tsc makes from
 * the build include). It then packs a real tarball, extracts it, and EXECUTES an import
 * of every published export subpath (resolving @aztec/* peers from the package's own
 * node_modules) so a broken export map fails here, not for a consumer.
 *
 * Run after `bun run clean && bun run build`. Exit 0 = tarball is clean and all exports load.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg: string): never => {
  console.error(`verify-pack: FAIL — ${msg}`);
  process.exit(1);
};

// 1. Parse the pack manifest.
const packJson = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgRoot }).toString();
const entries: Array<{ files: Array<{ path: string }> }> = JSON.parse(packJson);
const paths = entries.flatMap((e) => e.files.map((f) => f.path));

const MUST_INCLUDE = [
  'target/private_contract-PrivateFPC.json',
  'dist/target/private_contract-PrivateFPC.json',
  'canonical-deployment.json',
  'dist/src/artifacts/PrivateFPC.js',
];
const FORBIDDEN = [/counter/i, /artifactregistry/i];

for (const required of MUST_INCLUDE) {
  if (!paths.includes(required)) {
    fail(`tarball is missing required file "${required}". Packed files:\n${paths.join('\n')}`);
  }
}
for (const pattern of FORBIDDEN) {
  const leaked = paths.filter((p) => pattern.test(p));
  if (leaked.length > 0) {
    fail(`tarball contains forbidden path(s) matching ${pattern}: ${leaked.join(', ')}`);
  }
}
console.log(`verify-pack: packlist OK (${paths.length} files; no counter/artifactRegistry leak).`);

// 2. Pack a real tarball, extract, and execute-import every export from the extracted layout.
const workDir = mkdtempSync(join(tmpdir(), 'fp-verify-pack-'));
try {
  const tgz = execFileSync('npm', ['pack', '--pack-destination', workDir], { cwd: pkgRoot }).toString().trim();
  execFileSync('tar', ['-xzf', join(workDir, tgz), '-C', workDir]);
  const extracted = join(workDir, 'package'); // npm tarballs extract under package/
  // Resolve @aztec/* peers by pointing the extracted package at the repo's installed deps.
  const nm = join(extracted, 'node_modules');
  if (!existsSync(nm)) symlinkSync(join(pkgRoot, 'node_modules'), nm, 'dir');

  const jsSubpaths = ['.', './artifacts/private', './fee-payment-methods', './utils'];
  const jsonSubpaths = ['./package.json', './canonical-deployment.json'];
  // Drive a child node process INSIDE the extracted package so its `exports` map governs
  // resolution (proves the map itself resolves, and JSON uses the import attribute).
  const probe = [
    ...jsSubpaths.map(
      (s) => `await import(${JSON.stringify(`@alejoamiras/aztec-fee-payment/${s}`.replace('/.', ''))});`,
    ),
    ...jsonSubpaths.map(
      (s) =>
        `await import(${JSON.stringify(`@alejoamiras/aztec-fee-payment/${s.slice(2)}`)}, { with: { type: 'json' } });`,
    ),
    `console.log('exports-smoke: all resolved');`,
  ].join('\n');
  execFileSync('node', ['--input-type=module', '-e', probe], { cwd: extracted, stdio: 'inherit' });
  console.log('verify-pack: exports smoke OK — all subpaths import from the extracted tarball.');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
