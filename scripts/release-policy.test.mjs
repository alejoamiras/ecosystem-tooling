// node --test scripts/release-policy.test.mjs
// Covers the full dist-tag matrix + every rejection the workflow relies on.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeReleasePolicy, validatePackagesSubset } from './release-policy.mjs';

const AZTEC = '5.0.1';
const ok = (input) => {
  const r = computeReleasePolicy(input);
  assert.ok(!('error' in r), `expected success, got error: ${r.error}`);
  return r;
};
const err = (input) => {
  const r = computeReleasePolicy(input);
  assert.ok('error' in r, `expected error, got ${JSON.stringify(r)}`);
  return r.error;
};

test('matrix: release -> latest, no prerelease flag', () => {
  assert.deepEqual(ok({ mode: 'release', version: '5.0.1', aztecVersion: AZTEC, setLatest: false }), {
    tag: 'latest',
    prereleaseFlag: '',
  });
});

test('matrix: rehearsal canary -> canary tag, prerelease flag', () => {
  assert.deepEqual(ok({ mode: 'rehearsal', version: '0.0.0-canary.g1234abc', aztecVersion: AZTEC, setLatest: false }), {
    tag: 'canary',
    prereleaseFlag: '--prerelease',
  });
});

test('matrix: revision, set-latest=false -> revision tag', () => {
  assert.deepEqual(ok({ mode: 'revision', version: '5.0.1-revision.1', aztecVersion: AZTEC, setLatest: false }), {
    tag: 'revision',
    prereleaseFlag: '--prerelease',
  });
});

test('matrix: revision, set-latest=true -> latest tag (still prerelease release)', () => {
  assert.deepEqual(ok({ mode: 'revision', version: '5.0.1-revision.2', aztecVersion: AZTEC, setLatest: true }), {
    tag: 'latest',
    prereleaseFlag: '--prerelease',
  });
});

test('reject: set-latest=true in release mode', () => {
  assert.match(
    err({ mode: 'release', version: '5.0.1', aztecVersion: AZTEC, setLatest: true }),
    /set-latest is only valid in revision mode/,
  );
});

test('reject: set-latest=true in rehearsal mode', () => {
  assert.match(
    err({ mode: 'rehearsal', version: '0.0.0-canary.g1234abc', aztecVersion: AZTEC, setLatest: true }),
    /set-latest is only valid in revision mode/,
  );
});

test('reject: revision.0 (N must be >= 1)', () => {
  assert.match(
    err({ mode: 'revision', version: '5.0.1-revision.0', aztecVersion: AZTEC, setLatest: false }),
    /revision mode: version must be exactly/,
  );
});

test('reject: revision with leading-zero N', () => {
  assert.match(
    err({ mode: 'revision', version: '5.0.1-revision.01', aztecVersion: AZTEC, setLatest: false }),
    /revision mode/,
  );
});

test('reject: revision base != aztecVersion (wrong-aztec-base)', () => {
  assert.match(
    err({ mode: 'revision', version: '5.0.0-revision.1', aztecVersion: AZTEC, setLatest: false }),
    /revision mode: version must be exactly 5\.0\.1-revision/,
  );
});

test('reject: revision with an rc-style prerelease', () => {
  assert.match(
    err({ mode: 'revision', version: '5.0.1-rc.3', aztecVersion: AZTEC, setLatest: false }),
    /revision mode/,
  );
});

test('reject: rehearsal with a non-canary prerelease', () => {
  assert.match(
    err({ mode: 'rehearsal', version: '5.0.1-canary.gabc1234', aztecVersion: AZTEC, setLatest: false }),
    /rehearsal mode: version must be 0\.0\.0-canary/,
  );
});

test('reject: release version != aztecVersion', () => {
  assert.match(
    err({ mode: 'release', version: '5.0.0', aztecVersion: AZTEC, setLatest: false }),
    /release mode: input 5\.0\.0 != config\.aztecVersion 5\.0\.1/,
  );
});

test('reject: release mode with a prerelease version', () => {
  assert.match(
    err({ mode: 'release', version: '5.0.1-revision.1', aztecVersion: AZTEC, setLatest: false }),
    /release mode: version must be a plain X\.Y\.Z/,
  );
});

test('reject: malformed semver', () => {
  assert.match(err({ mode: 'revision', version: '5.0', aztecVersion: AZTEC, setLatest: false }), /invalid semver/);
});

test('reject: unknown mode', () => {
  assert.match(
    err({ mode: 'hotfix', version: '5.0.1-revision.1', aztecVersion: AZTEC, setLatest: false }),
    /unknown mode/,
  );
});

test('reject: non-boolean setLatest', () => {
  // @ts-expect-error deliberately wrong type
  assert.match(
    err({ mode: 'revision', version: '5.0.1-revision.1', aztecVersion: AZTEC, setLatest: 'true' }),
    /setLatest must be a boolean/,
  );
});

test('multi-digit revision N derives the revision tag', () => {
  assert.deepEqual(ok({ mode: 'revision', version: '5.0.1-revision.42', aztecVersion: AZTEC, setLatest: false }), {
    tag: 'revision',
    prereleaseFlag: '--prerelease',
  });
});

// ---------------------------------------------------------------------------
// Package-subset validation (per-package revision releases).
// ---------------------------------------------------------------------------

const ALL = 'aztec-benchmark private-fee-juice quota-paymaster';
const subsetOk = (input) => {
  const r = validatePackagesSubset({ releasePackages: ALL, ...input });
  assert.ok(!('error' in r), `expected success, got error: ${r.error}`);
  return r.packages;
};
const subsetErr = (input) => {
  const r = validatePackagesSubset({ releasePackages: ALL, ...input });
  assert.ok('error' in r, `expected error, got ${JSON.stringify(r)}`);
  return r.error;
};

test('subset: empty input publishes the full set for release/rehearsal', () => {
  assert.deepEqual(subsetOk({ mode: 'release', packages: '' }), ALL.split(' '));
  assert.deepEqual(subsetOk({ mode: 'rehearsal', packages: '   ' }), ALL.split(' '));
});

test('subset: revision REQUIRES an explicit single package', () => {
  // A revision number is per-package, so "everything" has no meaning here.
  assert.match(
    subsetErr({ mode: 'revision', packages: '' }),
    /requires --packages naming exactly one|exactly one package/,
  );
});

test('subset: revision accepts exactly one member', () => {
  assert.deepEqual(subsetOk({ mode: 'revision', packages: 'quota-paymaster' }), ['quota-paymaster']);
});

test('subset: revision REJECTS more than one package', () => {
  assert.match(subsetErr({ mode: 'revision', packages: 'quota-paymaster private-fee-juice' }), /exactly ONE package/);
});

test('subset: a non-member is rejected, naming what is known', () => {
  assert.match(subsetErr({ mode: 'revision', packages: 'aztec-standards' }), /not in RELEASE_PACKAGES/);
});

test('subset: duplicates are rejected rather than silently deduped', () => {
  assert.match(subsetErr({ mode: 'rehearsal', packages: 'quota-paymaster quota-paymaster' }), /duplicates/);
});

test('subset: order is normalized to the canonical publish order', () => {
  // Publish order is load-bearing; it must not depend on dispatch spelling.
  assert.deepEqual(subsetOk({ mode: 'rehearsal', packages: 'quota-paymaster aztec-benchmark' }), [
    'aztec-benchmark',
    'quota-paymaster',
  ]);
});

test('subset: comma-separated input is accepted (dispatch forms are free text)', () => {
  assert.deepEqual(subsetOk({ mode: 'rehearsal', packages: 'aztec-benchmark,quota-paymaster' }), [
    'aztec-benchmark',
    'quota-paymaster',
  ]);
});

test('subset: an explicit full list in revision mode is rejected, not silently widened', () => {
  assert.match(subsetErr({ mode: 'revision', packages: ALL }), /exactly ONE package/);
});

test('subset: an empty RELEASE_PACKAGES is an error, never an empty publish set', () => {
  const r = validatePackagesSubset({ mode: 'release', packages: '', releasePackages: '  ' });
  assert.ok('error' in r);
  assert.match(r.error, /releasePackages is empty/);
});
