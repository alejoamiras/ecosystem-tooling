import { describe, expect, test } from 'bun:test';

import { MIN_AGE_MS } from './aztec-scopes.ts';
import { ageCheck, lockPackages, lockTargets, registryTarball } from './npm-lock.ts';

const entry = (name: string, version: string) => ({
  version,
  resolved: registryTarball(name, version),
  integrity: 'sha512-x',
});
const lock = (packages: Record<string, unknown>) =>
  JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: {} }, ...packages } });

describe('lockPackages', () => {
  test('skips the root and identifies an aliased slot by its real package', () => {
    const rows = lockPackages(
      lock({
        'node_modules/viem': { name: '@aztec/viem', ...entry('@aztec/viem', '2.38.3') },
        'node_modules/a/node_modules/@scope/b': entry('@scope/b', '1.0.0'),
      }),
    );
    expect(rows.map((r) => [r.slot, r.name, r.version])).toEqual([
      ['node_modules/viem', '@aztec/viem', '2.38.3'],
      ['node_modules/a/node_modules/@scope/b', '@scope/b', '1.0.0'],
    ]);
  });

  test('rejects an entry whose tarball is another package, another registry, or unhashed', () => {
    for (const [e, err] of [
      // An alias claiming a name its URL does not install would be dated under the wrong name.
      [{ name: 'string-width', ...entry('evil-width', '4.2.3') }, /is not/],
      [{ ...entry('a', '1.0.0'), version: '1.0.1' }, /is not/],
      [{ ...entry('a', '1.0.0'), resolved: 'https://mirror.example/a/-/a-1.0.0.tgz' }, /is not/],
      [{ ...entry('a', '1.0.0'), integrity: undefined }, /needs version, resolved and integrity/],
      [{ resolved: '../local', link: true }, /needs version, resolved and integrity/],
    ] as const) {
      expect(() => lockPackages(lock({ 'node_modules/string-width': e }))).toThrow(err);
    }
    expect(() => lockPackages(JSON.stringify({ lockfileVersion: 2, packages: {} }))).toThrow(/lockfileVersion 3/);
  });
});

describe('ageCheck', () => {
  const now = Date.parse('2026-10-15T00:00:00Z');
  const at = (ms: number) => new Date(ms).toISOString();
  const targets = { aztecVersion: '6.0.0-rc.3', aztecFoundationVersion: '6.0.0-rc.6' };
  const row = (name: string, publishedAt: string | undefined, version = '1.0.0') => ({ name, version, publishedAt });
  const fresh = at(now - 1000);

  test('the 7-day boundary is old enough; younger is refused unless Aztec-scoped at its lockstep version', () => {
    expect(
      ageCheck(
        [
          row('old-enough', at(now - MIN_AGE_MS)),
          row('too-young', at(now - MIN_AGE_MS + 1)),
          row('@aztec-labs/aztec', fresh, '6.0.0-rc.3'),
          row('@aztec-foundation/bb.js', fresh, '6.0.0-rc.6'),
          // The scope alone excuses nothing: these are not the versions the lockstep release pins.
          row('@aztec-labs/stdlib', fresh, '6.0.0-rc.4'),
          row('@aztec-foundation/bb.js', fresh, '6.0.0-rc.3'),
          row('@aztec/viem', fresh, '6.0.0-rc.3'),
        ],
        now,
        targets,
      ),
    ).toEqual({
      youngAztec: ['@aztec-foundation/bb.js@6.0.0-rc.6', '@aztec-labs/aztec@6.0.0-rc.3'],
      tooYoung: [
        '@aztec-foundation/bb.js@6.0.0-rc.3',
        '@aztec-labs/stdlib@6.0.0-rc.4',
        '@aztec/viem@6.0.0-rc.3',
        'too-young@1.0.0',
      ],
    });
  });

  test('a future publish time counts as young; a missing one refuses', () => {
    expect(ageCheck([row('from-the-future', at(now + 86_400_000))], now, targets).tooYoung).toEqual([
      'from-the-future@1.0.0',
    ]);
    expect(() => ageCheck([row('undated', undefined)], now, targets)).toThrow(/no publish time for: undated@1.0.0/);
  });
});

describe('lockTargets', () => {
  const withAztec = (version: string, dependencies: Record<string, string>) =>
    lock({ 'node_modules/@aztec-labs/aztec': { ...entry('@aztec-labs/aztec', version), dependencies } });

  const deps = { '@aztec-foundation/bb.js': '6.0.0-rc.6', x: '^1' };

  test('takes the foundation version @aztec-labs/aztec pins on the public registry', () => {
    expect(lockTargets(withAztec('6.0.0-rc.3', deps), '6.0.0-rc.3', deps)).toEqual({
      aztecVersion: '6.0.0-rc.3',
      aztecFoundationVersion: '6.0.0-rc.6',
    });
    expect(() => lockTargets(withAztec('6.0.0-rc.4', deps), '6.0.0-rc.3', deps)).toThrow(/not 6.0.0-rc.3/);
    expect(() => lockTargets(withAztec('6.0.0-rc.3', deps), '6.0.0-rc.3', { '@aztec-foundation/bb.js': '^6' })).toThrow(
      /one exact/,
    );
  });

  test('refuses a lock whose metadata names another foundation version than the registry', () => {
    // A mirror could otherwise choose which young foundation version the age check excuses.
    const altered = withAztec('6.0.0-rc.3', { '@aztec-foundation/bb.js': '6.0.0-rc.99' });
    expect(() => lockTargets(altered, '6.0.0-rc.3', deps)).toThrow(
      /pins foundation "6.0.0-rc.99", the registry 6.0.0-rc.6/,
    );
  });
});
