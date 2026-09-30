#!/usr/bin/env bun
/**
 * Fail-closed tarball manifest assertion (plan aztec-5-stable D2v3).
 *
 * `npm publish <tarball>` publishes whatever version is INSIDE the tarball — the workflow
 * input is not consulted. This assertion is the invariant that makes a mis-configured
 * dispatch (e.g. rehearsal mode without the overlay) die before anything reaches the
 * registry: embedded name/version must equal expectations, Aztec pins must satisfy
 * scripts/lib/manifest-policy.ts with the SOURCE manifest's peer set, and internal
 * `@alejoamiras/*` pins must equal the version being published.
 *
 * Usage: bun scripts/assert-tarball-meta.ts <tarball> <expected-name> <expected-version> <aztec-version>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEP_SECTIONS, type Manifest, optionalPeers, validateManifest } from './lib/manifest-policy.ts';

const [tarball, expectedName, expectedVersion, aztecVersion] = process.argv.slice(2);
if (!tarball || !expectedName || !expectedVersion || !aztecVersion) {
  console.error('usage: assert-tarball-meta.ts <tarball> <expected-name> <expected-version> <aztec-version>');
  process.exit(1);
}

const manifest: Manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json']).toString());
const sourceDir = expectedName.replace(/^@alejoamiras\//, '');
const source: Manifest = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'packages', sourceDir, 'package.json'), 'utf8'),
);

const errors: string[] = [];
if (manifest.name !== expectedName) errors.push(`name is ${manifest.name}, expected ${expectedName}`);
if (manifest.version !== expectedVersion) errors.push(`version is ${manifest.version}, expected ${expectedVersion}`);
errors.push(
  ...validateManifest(manifest, {
    aztecVersion,
    expectedPeers: Object.keys(source.peerDependencies ?? {}),
    expectedOptionalPeers: optionalPeers(source),
  }),
);
for (const section of DEP_SECTIONS) {
  for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
    if (name.startsWith('@alejoamiras/') && spec !== expectedVersion)
      errors.push(`${section}.${name} is ${spec}, expected published version ${expectedVersion}`);
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(`assert-tarball-meta: ${tarball} FAILED`);
  process.exit(1);
}
console.log(
  `  ✓ ${tarball}: ${manifest.name}@${manifest.version}, Aztec pins == ${aztecVersion}, internal pins == ${expectedVersion}`,
);
