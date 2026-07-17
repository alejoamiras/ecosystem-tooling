#!/usr/bin/env bun
/**
 * Version overlay for release.yml's rehearsal/revision modes (plan aztec-5-stable, D2v3/D16;
 * `hotfix` mode renamed to `revision` in plan fee-payment-revisions-rename).
 *
 * Stamps OVERLAY_VERSION onto the publishable packages — `version` plus every
 * internal `@alejoamiras/aztec-*` exact pin — WITHOUT touching `@aztec/*` peer pins
 * (those stay at the lockstep Aztec version the code was built against).
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

for (const dir of pkgDirs) {
  const p = join(ROOT, 'packages', dir, 'package.json');
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  const before = pkg.version;
  pkg.version = overlay;
  let pins = 0;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      if (name.startsWith('@alejoamiras/aztec-')) {
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
