// node --test scripts/release-policy.test.mjs
// Covers the full dist-tag matrix + every rejection the workflow relies on.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeReleasePolicy } from './release-policy.mjs';

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
