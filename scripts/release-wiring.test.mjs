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
  // The per-package checks jobs gate the build (benchmark's build job doubles
  // as its check). Anchored on the `build:` job KEY, not on a job shape — a
  // future job with the same runs-on/timeout shape must not retarget this.
  const buildJob = releaseYml.match(/^ {2}build:\n(?:.*\n)*?\s*needs:\s*\[([^\]]*)\]/m);
  assert.ok(buildJob, "the build job's needs array was not found");
  for (const job of ['private-fee-juice-checks', 'quota-paymaster-checks', 'benchmark-build']) {
    assert.ok(buildJob[1].includes(job), `build job does not wait on ${job}`);
  }
});

test('actively-published EQUALS release-ready, ordered, and named in the notes template', () => {
  const active = activelyPublished();
  // Under the approved A1(a) posture every release-ready package is actively
  // published — EQUALITY, not subset (post-impl audit finding #10: a subset
  // check would silently bless deleting quota-paymaster from the env list).
  // Publish order is the string order and is load-bearing:
  // benchmark → fee-juice → quota-paymaster.
  assert.deepEqual(active, RELEASE_READY, 'RELEASE_PACKAGES must list every release-ready package, in canonical order');
  for (const pkg of active) {
    assert.ok(
      releaseYml.includes(`@alejoamiras/${pkg}`),
      `${pkg}: not named in the release-notes template (the in-run grep guard would fail the dispatch)`,
    );
    // The install line is its own hand-maintained locus — the name grep above
    // passes even when the `bun add` line is missing (finding #10).
    assert.match(
      releaseYml,
      new RegExp(`bun add (?:-D )?@alejoamiras/${pkg}@`),
      `${pkg}: missing an install (\`bun add\`) line in the release-notes template`,
    );
  }

  // The notes template holds THREE hand-maintained per-package sublists (table
  // row, install line, docs-link line). The in-run grep guard only proves the
  // name appears SOMEWHERE — the docs-link line slipped exactly that way once
  // (review finding), so assert it separately.
  const docsLine = releaseYml.match(/Per-package usage: ([^\n]+)/);
  assert.ok(docsLine, 'release-notes docs-link line not found');
  for (const pkg of active) {
    assert.ok(
      docsLine[1].includes(`packages/${pkg}#readme`),
      `${pkg}: missing from the release-notes "Per-package usage" docs-link line`,
    );
  }
});

test('the retired first-publish warning does not linger', () => {
  // quota-paymaster@5.0.1 was first-published via the one-time bootstrap
  // (2026-08-07) and its trusted publisher exists. A stale NEVER-published
  // warning would send a future operator hunting for a bootstrap that is
  // already done.
  assert.doesNotMatch(
    releaseYml,
    /quota-paymaster has NEVER been published/,
    'release.yml still carries the pre-bootstrap warning; quota-paymaster is published',
  );
});
