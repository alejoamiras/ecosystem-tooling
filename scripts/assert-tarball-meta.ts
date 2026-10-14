#!/usr/bin/env bun
/**
 * Fail-closed tarball manifest assertion.
 *
 * `npm publish <tarball>` publishes whatever version is INSIDE the tarball — the workflow
 * input is not consulted. This assertion is the invariant that makes a mis-configured
 * dispatch (e.g. rehearsal mode without the overlay) die before anything reaches the
 * registry: embedded name/version must equal expectations, Aztec pins must satisfy
 * scripts/lib/manifest-policy.ts with the SOURCE manifest's peer set, and internal
 * `@alejoamiras/*` pins must equal the version being published. The foundation version comes
 * from the root config; the argv Aztec version must equal the config's.
 *
 * Usage: bun scripts/assert-tarball-meta.ts <tarball> <expected-name> <expected-version> <aztec-version>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readAztecVersions } from './lib/aztec-scopes.ts';
import { DEP_SECTIONS, type Manifest, optionalPeers, validateManifest } from './lib/manifest-policy.ts';

const [tarball, expectedName, expectedVersion, aztecVersion] = process.argv.slice(2);
if (!tarball || !expectedName || !expectedVersion || !aztecVersion) {
  console.error('usage: assert-tarball-meta.ts <tarball> <expected-name> <expected-version> <aztec-version>');
  process.exit(1);
}

const ROOT = join(import.meta.dir, '..');
const versions = readAztecVersions(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).config);
const manifest: Manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json']).toString());
const sourceDir = expectedName.replace(/^@alejoamiras\//, '');
const source: Manifest = JSON.parse(readFileSync(join(ROOT, 'packages', sourceDir, 'package.json'), 'utf8'));

const errors: string[] = [];
if (aztecVersion !== versions.aztecVersion) {
  errors.push(`argv aztec version ${aztecVersion} != root config.aztecVersion ${versions.aztecVersion}`);
}
if (manifest.name !== expectedName) errors.push(`name is ${manifest.name}, expected ${expectedName}`);
if (manifest.version !== expectedVersion) errors.push(`version is ${manifest.version}, expected ${expectedVersion}`);
errors.push(
  ...validateManifest(manifest, {
    ...versions,
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
  `  ✓ ${tarball}: ${manifest.name}@${manifest.version}, Aztec pins == ${aztecVersion} / foundation ${versions.aztecFoundationVersion}, internal pins == ${expectedVersion}`,
);
