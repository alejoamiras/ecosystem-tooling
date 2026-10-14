import { describe, expect, test } from 'bun:test';

import { DEP_SECTIONS, type Manifest, optionalPeers, validateManifest } from './manifest-policy.ts';

const V = '6.0.0-rc.3';
// Upstream versions the foundation scope separately (labs rc.3 depends on foundation rc.6).
const F = '6.0.0-rc.6';
const versions = { aztecVersion: V, aztecFoundationVersion: F };

// Shaped like quota-paymaster's published manifest: labs + foundation peers, an optional peer
// in each world, and the viem alias in devDependencies.
const good = (): Manifest => ({
  name: '@alejoamiras/quota-paymaster',
  version: V,
  devDependencies: { '@aztec-labs/stdlib': V, viem: 'npm:@aztec/viem@2.38.3', vitest: '4.1.4' },
  peerDependencies: {
    '@aztec-labs/aztec.js': V,
    '@aztec-labs/wallets': V,
    '@aztec-foundation/l1-artifacts': F,
    tsx: '^4.19.0',
  },
  peerDependenciesMeta: { '@aztec-labs/wallets': { optional: true }, tsx: { optional: true } },
});
const publishPolicy = {
  ...versions,
  expectedPeers: Object.keys(good().peerDependencies ?? {}),
  expectedOptionalPeers: optionalPeers(good()),
};
const errs = (m: Manifest, onPublishPath = false) => validateManifest(m, onPublishPath ? publishPolicy : versions);

test('a compliant manifest passes, including the publish-path checks', () => {
  expect(errs(good(), true)).toEqual([]);
});

describe('names and pins', () => {
  test('a legacy key is rejected in every dependency section', () => {
    for (const section of DEP_SECTIONS) {
      expect(errs({ [section]: { '@aztec/stdlib': V } })).toEqual([expect.stringMatching(/legacy @aztec\/\* name/)]);
    }
  });

  test('a wrong pin is rejected', () => {
    expect(errs({ peerDependencies: { '@aztec-foundation/bb.js': '5.0.1' } })[0]).toMatch(/expected exactly/);
  });

  test("each scope is held to its own version, never the other scope's", () => {
    expect(errs({ peerDependencies: { '@aztec-foundation/bb.js': V } })).toEqual([
      `peerDependencies.@aztec-foundation/bb.js is ${V}, expected exactly ${F}`,
    ]);
    expect(errs({ dependencies: { '@aztec-labs/stdlib': F } })).toEqual([
      `dependencies.@aztec-labs/stdlib is ${F}, expected exactly ${V}`,
    ]);
    expect(errs({ dependencies: { bb: `npm:@aztec-foundation/bb.js@${V}` } })[0]).toMatch(
      new RegExp(`aliases @aztec-foundation/bb.js@${V}, expected exactly ${F}`),
    );
    expect(errs({ dependencies: { bb: `npm:@aztec-foundation/bb.js@${F}`, '@aztec-labs/stdlib': V } })).toEqual([]);
  });
});

describe('aliases are judged by target', () => {
  test('an innocently named alias to a wrong-version labs package', () => {
    expect(errs({ dependencies: { helper: 'npm:@aztec-labs/stdlib@6.0.0-rc.2' } })[0]).toMatch(/aliases @aztec-labs/);
  });

  test('a legacy alias other than viem', () => {
    expect(errs({ dependencies: { stdlib: 'npm:@aztec/stdlib@5.0.1' } })[0]).toMatch(/only viem/);
    expect(errs({ dependencies: { notviem: 'npm:@aztec/viem@2.38.3' } })[0]).toMatch(/only viem/);
  });

  test('a versionless alias installs as `*`, so it is refused', () => {
    expect(errs({ dependencies: { helper: 'npm:@aztec-labs/stdlib' } })[0]).toMatch(/aliases @aztec-labs\/stdlib@,/);
    expect(errs({ dependencies: { helper: 'npm:@aztec/stdlib@' } })[0]).toMatch(/legacy @aztec\/stdlib/);
    expect(errs({ devDependencies: { viem: 'npm:@aztec/viem' } })[0]).toMatch(/expected an exact version/);
    // npm accepts the protocol in any case.
    expect(errs({ dependencies: { helper: 'NPM:@aztec/stdlib@5.0.1' } })[0]).toMatch(/legacy @aztec\/stdlib/);
    expect(errs({ dependencies: { helper: 'Npm:@aztec-labs/stdlib' } })[0]).toMatch(/aliases @aztec-labs\/stdlib@,/);
  });

  test('the viem alias must be exact', () => {
    expect(errs({ devDependencies: { viem: 'npm:@aztec/viem@^2.38.3' } })[0]).toMatch(/exact version/);
  });
});

describe('peer metadata and publish-path peer sets', () => {
  test('an orphan or legacy peerDependenciesMeta key', () => {
    const m = { ...good(), peerDependenciesMeta: { '@aztec/wallets': { optional: true } } };
    expect(errs(m)).toEqual([expect.stringMatching(/legacy/), expect.stringMatching(/no matching peerDependencies/)]);
  });

  test('missing and extra peers', () => {
    const missing = good();
    delete missing.peerDependencies?.['@aztec-foundation/l1-artifacts'];
    expect(errs(missing, true)).toEqual([expect.stringMatching(/peer set/)]);
    const extra = good();
    (extra.peerDependencies ?? {})['@aztec-labs/pxe'] = V;
    expect(errs(extra, true)).toEqual([expect.stringMatching(/peer set/)]);
  });

  test('an optional-peer mismatch', () => {
    const m = { ...good(), peerDependenciesMeta: { tsx: { optional: true }, '@aztec-labs/wallets': {} } };
    expect(errs(m, true)).toEqual([expect.stringMatching(/optional peers/)]);
  });

  test('a peer set with no @aztec-labs/* entry', () => {
    const m: Manifest = { peerDependencies: { '@aztec-foundation/bb.js': F } };
    const r = validateManifest(m, { ...versions, expectedPeers: ['@aztec-foundation/bb.js'] });
    expect(r).toEqual([expect.stringMatching(/no @aztec-labs\/\* peer/)]);
  });
});
