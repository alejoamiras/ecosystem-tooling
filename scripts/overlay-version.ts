#!/usr/bin/env bun
/**
 * Version overlay for release.yml's rehearsal/revision modes (plan aztec-5-stable, D2v3/D16;
 * `hotfix` mode renamed to `revision` in plan fee-payment-revisions-rename).
 *
 * Stamps OVERLAY_VERSION onto the publishable packages — `version` plus every
 * internal cross-package exact pin (any dep whose name is itself a workspace package) —
 * WITHOUT touching `@aztec/*` peer pins (those stay at the lockstep Aztec version the code
 * was built against). Internal pins are detected by the workspace package-name SET, not a
 * name prefix, so a package rename (e.g. aztec-fee-payment → private-fee-juice) can't
 * silently drop a pin from the overlay.
 *
 * Must run AFTER `bun install --frozen-lockfile` (the overlay diverges manifests from
 * bun.lock by design) and BEFORE build/pack. The workflow's post-pack assertion verifies
 * every tarball's embedded manifest: name, version == input, @aztec/* peers == aztecVersion,
 * internal pins == input — the fail-closed backstop that makes a mis-dispatched run die
 * instead of publishing the committed (real) version under a rehearsal tag.
 *
 * Usage: bun scripts/overlay-version.ts <overlay-version>
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const overlay = process.argv[2];
if (!overlay || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(overlay)) {
  console.error(`overlay-version: invalid or missing version argument: ${overlay ?? '<none>'}`);
  process.exit(1);
}

const aztecVersion: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).config.aztecVersion;
if (overlay === aztecVersion) {
  console.error(`overlay-version: ${overlay} equals config.aztecVersion — release mode needs no overlay`);
  process.exit(1);
}

const pkgDirs = readdirSync(join(ROOT, 'packages')).filter((d) => statSync(join(ROOT, 'packages', d)).isDirectory());

// The set of workspace package NAMES (from each packages/*/package.json). Internal cross-
// package pins are detected by membership in this set — NOT a `@alejoamiras/aztec-*` prefix —
// so renaming a package doesn't silently exclude it from the overlay.
const workspaceNames = new Set<string>(
  pkgDirs.map((d) => JSON.parse(readFileSync(join(ROOT, 'packages', d, 'package.json'), 'utf8')).name),
);

for (const dir of pkgDirs) {
  const p = join(ROOT, 'packages', dir, 'package.json');
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  const before = pkg.version;
  pkg.version = overlay;
  let pins = 0;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      if (workspaceNames.has(name)) {
        pkg[section][name] = overlay;
        pins++;
      }
      if (name.startsWith('@aztec/') && pkg[section][name] !== aztecVersion) {
        console.error(
          `overlay-version: REFUSING — ${dir} ${section}.${name} is ${pkg[section][name]}, expected aztecVersion ${aztecVersion}`,
        );
        process.exit(1);
      }
    }
  }
  writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`overlaid packages/${dir}: ${before} -> ${overlay} (${pins} internal pins)`);
}

console.log(`overlay-version: done — @aztec/* pins untouched (still ${aztecVersion})`);
