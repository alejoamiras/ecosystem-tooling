// Structural guard for release.yml's hand-maintained package loci (plan
// quota-fpc-extraction, final codex condition). Two sets are modeled:
//
//  - RELEASE-READY: packages fully wired into the pipeline's build/check
//    machinery (checks job in build.needs, a build-step block, a
//    verify-tarball arg, a CHECKS entry in verify-tarball.ts). quota-paymaster
//    is asserted here from day one, so dormant wiring cannot silently rot.
//  - ACTIVELY-PUBLISHED: the RELEASE_PACKAGES env list. Must be a subset of
//    release-ready, and each member must also appear in the release-notes
//    template (name + install line) — the human-facing loci the env list
//    cannot generate.
//
// Run with the policy tests: node --test scripts/release-policy.test.mjs scripts/release-wiring.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseYml = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
const verifyTarball = readFileSync(join(ROOT, 'scripts/verify-tarball.ts'), 'utf8');

/** Everything this repo considers wired for release, dormant or active. */
const RELEASE_READY = ['aztec-benchmark', 'private-fee-juice', 'quota-paymaster'];

function activelyPublished() {
  const match = releaseYml.match(/RELEASE_PACKAGES:\s*"([^"]+)"/);
  assert.ok(match, 'RELEASE_PACKAGES env line not found in release.yml');
  return match[1].trim().split(/\s+/);
}

test('every release-ready package has its full build/check wiring', () => {
  for (const pkg of RELEASE_READY) {
    assert.match(releaseYml, new RegExp(`packages/${pkg}`), `${pkg}: no reference at all in release.yml`);
    // A build-step block (either the bun build line or the compile subshell).
    assert.ok(
      releaseYml.includes(`bun run --cwd packages/${pkg} build`) ||
        releaseYml.includes(`cd packages/${pkg} && aztec compile`),
      `${pkg}: no "Build all packages" block — RELEASE_PACKAGES loops would find no tarball`,
    );
    // The verify-tarball invocation must name it…
    const tarballLine = releaseYml.match(/verify-tarball\.ts ([^\n]+)/);
    assert.ok(tarballLine, 'verify-tarball invocation not found');
    assert.ok(tarballLine[1].includes(`packages/${pkg}`), `${pkg}: missing from the verify-tarball.ts arg list`);
    // …and verify-tarball.ts must define real checks for it.
    assert.ok(
      verifyTarball.includes(`'${pkg}':`),
      `${pkg}: no CHECKS entry in scripts/verify-tarball.ts (the gate fails loudly, but add it deliberately)`,
    );
  }
  // The per-package checks jobs gate the build (benchmark's build job doubles as its check).
  const needsLine = releaseYml.match(/needs:\s*\[([^\]]*)\]\s*\n\s*runs-on: ubuntu-latest\s*\n\s*timeout-minutes: 45/);
  assert.ok(needsLine, "the build job's needs array was not found");
  for (const job of ['private-fee-juice-checks', 'quota-paymaster-checks', 'benchmark-build']) {
    assert.ok(needsLine[1].includes(job), `build job does not wait on ${job}`);
  }
});

test('actively-published ⊆ release-ready, ordered, and named in the notes template', () => {
  const active = activelyPublished();
  for (const pkg of active) {
    assert.ok(RELEASE_READY.includes(pkg), `${pkg} is in RELEASE_PACKAGES but not release-ready`);
    assert.ok(
      releaseYml.includes(`@alejoamiras/${pkg}`),
      `${pkg}: not named in the release-notes template (the in-run grep guard would fail the dispatch)`,
    );
  }
  // Publish order is the string order and is load-bearing.
  assert.deepEqual(
    active,
    RELEASE_READY.filter((p) => active.includes(p)),
    'RELEASE_PACKAGES order deviates from the canonical benchmark → fee-juice → quota-paymaster order',
  );
});

test('the first-publish trap is documented where the operator will hit it', () => {
  // quota-paymaster is wired but unpublished: the workflow must carry the
  // bootstrap warning so a failed dispatch reads as designed, not broken.
  assert.match(
    releaseYml,
    /quota-paymaster has NEVER been published|first-publish\s+bootstrap/i,
    'release.yml lost the quota-paymaster bootstrap warning comment',
  );
});
