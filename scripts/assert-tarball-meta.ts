#!/usr/bin/env bun
/**
 * Fail-closed tarball manifest assertion (plan aztec-5-stable D2v3).
 *
 * `npm publish <tarball>` publishes whatever version is INSIDE the tarball — the workflow
 * input is not consulted. This assertion is the invariant that makes a mis-configured
 * dispatch (e.g. rehearsal mode without the overlay) die before anything reaches the
 * registry: embedded name/version must equal expectations, `@aztec/*` peers must stay at
 * the lockstep Aztec version, and internal `@alejoamiras/*` pins must equal the version
 * being published.
 *
 * Usage: bun scripts/assert-tarball-meta.ts <tarball> <expected-name> <expected-version> <aztec-version>
 */
import { execFileSync } from 'node:child_process';

const [tarball, expectedName, expectedVersion, aztecVersion] = process.argv.slice(2);
if (!tarball || !expectedName || !expectedVersion || !aztecVersion) {
  console.error('usage: assert-tarball-meta.ts <tarball> <expected-name> <expected-version> <aztec-version>');
  process.exit(1);
}

const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json']).toString());
let fail = 0;
const err = (msg: string) => {
  console.error(`  ✗ ${msg}`);
  fail = 1;
};

if (manifest.name !== expectedName) err(`name is ${manifest.name}, expected ${expectedName}`);
if (manifest.version !== expectedVersion) err(`version is ${manifest.version}, expected ${expectedVersion}`);

for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
  for (const [name, spec] of Object.entries((manifest[section] ?? {}) as Record<string, string>)) {
    if (name.startsWith('@aztec/') && spec !== aztecVersion)
      err(`${section}.${name} is ${spec}, expected aztecVersion ${aztecVersion}`);
    if (name.startsWith('@alejoamiras/') && spec !== expectedVersion)
      err(`${section}.${name} is ${spec}, expected published version ${expectedVersion}`);
  }
}

if (fail) {
  console.error(`assert-tarball-meta: ${tarball} FAILED`);
  process.exit(1);
}
console.log(
  `  ✓ ${tarball}: ${manifest.name}@${manifest.version}, @aztec/* == ${aztecVersion}, internal pins == ${expectedVersion}`,
);
