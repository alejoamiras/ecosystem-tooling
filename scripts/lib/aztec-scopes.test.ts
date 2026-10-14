import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AZTEC_NR_GIT,
  closureEdge,
  foundationVersionOf,
  lockfilePairs,
  lockfileScopeErrors,
  parseAlias,
  pinnedVersion,
  readAztecVersions,
  sweepNargoLine,
  youngNames,
} from './aztec-scopes.ts';

const T = '6.0.0-rc.1';
const L = '6.0.0-rc.3';
const F = '6.0.0-rc.6';
const split = { aztecVersion: L, aztecFoundationVersion: F };
const same = { aztecVersion: T, aztecFoundationVersion: T };

describe('sweepNargoLine', () => {
  test('retags an aztec-nr dep and leaves noir-lang deps alone', () => {
    const aztec = `aztec = { git = "${AZTEC_NR_GIT}", tag = "v5.0.1", directory = "aztec" }`;
    expect(sweepNargoLine(aztec, T)).toEqual({ line: aztec.replace('v5.0.1', `v${T}`) });
    const noir = 'sha512 = { git = "https://github.com/noir-lang/sha512", tag = "v0.1.0" }';
    expect(sweepNargoLine(noir, T)).toEqual({ line: noir });
  });

  test('a legacy aztec-nr home is an error, trailing slash or not', () => {
    for (const url of [
      'https://github.com/AztecProtocol/aztec-packages/',
      'https://github.com/AztecProtocol/aztec-nr',
    ]) {
      const r = sweepNargoLine(
        `aztec = { git = "${url}", tag = "v5.0.1", directory = "noir-projects/aztec-nr/aztec" }`,
        T,
      );
      expect(r.error).toMatch(/legacy aztec-nr git URL/);
    }
  });
});

describe('closureEdge', () => {
  test('lockstep deps ride the target; aliases keep their own version', () => {
    expect(closureEdge('p', '@aztec-labs/stdlib', T, same)).toEqual({ name: '@aztec-labs/stdlib', version: T });
    expect(closureEdge('p', 'viem', 'npm:@aztec/viem@2.38.3', same)).toEqual({
      name: '@aztec/viem',
      version: '2.38.3',
    });
    expect(closureEdge('p', 'lodash', '4.17.21', same)).toBeUndefined();
  });

  test('a foundation dep pinned off-target fails loudly', () => {
    const r = closureEdge('@aztec-labs/aztec.js', '@aztec-foundation/l1-artifacts', '6.0.0-rc.2', same);
    expect(r).toEqual({ error: expect.stringMatching(/upstream versions diverged/) });
  });

  test('ranges and aliases must actually resolve to the target', () => {
    const diverged = { error: expect.stringMatching(/upstream versions diverged/) };
    expect(closureEdge('p', '@aztec-labs/stdlib', `^${T}`, same)).toEqual({ name: '@aztec-labs/stdlib', version: T });
    expect(closureEdge('p', '@aztec-labs/stdlib', '^5.0.1', same)).toEqual(diverged);
    expect(closureEdge('p', 'bb', 'npm:@aztec-foundation/bb.js@5.0.1', same)).toEqual(diverged);
    expect(closureEdge('p', 'bb', 'npm:@aztec-foundation/bb.js', same)).toEqual(diverged);
    expect(closureEdge('p', 'viem', 'npm:@aztec/viem', same)).toEqual({ error: expect.stringMatching(/not an exact/) });
    expect(closureEdge('p', 'bb', 'NPM:@aztec-foundation/bb.js@5.0.1', same)).toEqual(diverged);
  });

  test('split scopes: each edge rides its own scope target, and crossing them fails', () => {
    const diverged = { error: expect.stringMatching(/upstream versions diverged/) };
    expect(closureEdge('p', '@aztec-foundation/bb.js', F, split)).toEqual({
      name: '@aztec-foundation/bb.js',
      version: F,
    });
    expect(closureEdge('p', '@aztec-labs/stdlib', L, split)).toEqual({ name: '@aztec-labs/stdlib', version: L });
    expect(closureEdge('p', '@aztec-foundation/bb.js', L, split)).toEqual(diverged);
    expect(closureEdge('p', '@aztec-labs/stdlib', F, split)).toEqual(diverged);
    expect(closureEdge('p', 'bb', `npm:@aztec-foundation/bb.js@${L}`, split)).toEqual(diverged);
  });
});

describe('scope versions', () => {
  test('pinnedVersion maps each scope to its own key', () => {
    expect(pinnedVersion('@aztec-labs/stdlib', split)).toBe(L);
    expect(pinnedVersion('@aztec-foundation/bb.js', split)).toBe(F);
    expect(pinnedVersion('@aztec/viem', split)).toBeUndefined();
    expect(pinnedVersion('@aztec-labsx/stdlib', split)).toBeUndefined();
  });

  test('readAztecVersions fails closed on a missing or non-exact key', () => {
    expect(readAztecVersions(split)).toEqual(split);
    expect(() => readAztecVersions({ aztecVersion: L })).toThrow(/aztecFoundationVersion/);
    expect(() => readAztecVersions({ ...split, aztecFoundationVersion: `^${F}` })).toThrow(/aztecFoundationVersion/);
    expect(() => readAztecVersions(undefined)).toThrow(/aztecVersion/);
  });

  test('foundationVersionOf reads exactly one exact foundation version', () => {
    const deps = { '@aztec-foundation/bb.js': F, '@aztec-labs/foundation': L, lodash: '4.17.21' };
    expect(foundationVersionOf('aztec', deps)).toBe(F);
    const bad = { error: expect.stringMatching(/expected one exact @aztec-foundation/) };
    expect(foundationVersionOf('aztec', { '@aztec-labs/foundation': L })).toEqual(bad);
    expect(foundationVersionOf('aztec', { ...deps, '@aztec-foundation/l1-artifacts': '6.0.0-rc.5' })).toEqual(bad);
    expect(foundationVersionOf('aztec', { '@aztec-foundation/bb.js': `^${F}` })).toEqual(bad);
  });

  // bun.lock-shaped: trailing commas, [ident, registry, meta, integrity] entries.
  const lockOf = (bb: string, stdlibAsks: string) => `{
    "lockfileVersion": 1,
    "packages": {
      "@aztec-foundation/bb.js": ["@aztec-foundation/bb.js@${bb}", "", {}, "sha512-a"],
      "@aztec-labs/stdlib": ["@aztec-labs/stdlib@${L}", "", { "dependencies": { "@aztec-foundation/bb.js": "${stdlibAsks}", "viem": "npm:@aztec/viem@2.38.3" } }, "sha512-b"],
      "viem": ["@aztec/viem@2.38.3", "", {}, "sha512-c"],
    },
  }`;

  test('lockfileScopeErrors: resolutions and declared specs must both match the scope targets', () => {
    expect(lockfileScopeErrors(lockOf(F, F), split)).toEqual([]);
    expect(lockfileScopeErrors(lockOf(L, F), split)).toEqual([
      `bun.lock resolves @aztec-foundation/bb.js@${L}, expected @aztec-foundation/bb.js@${F}`,
    ]);
  });

  test('lockfileScopeErrors: an override that resolves a version labs never asked for still fails', () => {
    // Config, pins and the resolution all say rc.1; the labs package's own spec says rc.6.
    const forced = { aztecVersion: L, aztecFoundationVersion: T };
    expect(lockfileScopeErrors(lockOf(T, F), forced)).toEqual([expect.stringMatching(/upstream versions diverged/)]);
  });
});

describe('youngNames', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  test('exempts only versions inside the 7-day window', () => {
    const rows = [
      { name: '@aztec-labs/a', version: T, publishedAt: '2026-09-23T20:07:00Z' },
      { name: '@aztec-foundation/b', version: T, publishedAt: '2026-09-20T00:00:00Z' },
    ];
    expect(youngNames(rows, now)).toEqual(['@aztec-labs/a']);
  });

  test('an unknown publish time is a failure, never "old enough"', () => {
    expect(() => youngNames([{ name: '@aztec-labs/a', version: T, publishedAt: undefined }], now)).toThrow(
      /no publish time for: @aztec-labs\/a/,
    );
  });
});

test('parseAlias + lockfilePairs read bun.lock-shaped entries across all scopes', () => {
  expect(parseAlias('npm:@aztec/viem@2.38.3')).toEqual({ target: '@aztec/viem', version: '2.38.3' });
  expect(parseAlias('2.38.3')).toBeUndefined();
  // npm installs a versionless alias as `*`; it must surface, not vanish.
  expect(parseAlias('npm:@aztec-labs/stdlib')).toEqual({ target: '@aztec-labs/stdlib', version: '' });
  expect(parseAlias('npm:@aztec/stdlib@')).toEqual({ target: '@aztec/stdlib', version: '' });
  const lock = `
    "@aztec-labs/stdlib": ["@aztec-labs/stdlib@${T}", "", {}, "sha512-x"],
    "viem": ["@aztec/viem@2.38.3", "", {}, "sha512-y"],
    "@aztec-foundation/bb.js": ["@aztec-foundation/bb.js@${T}", "", {}, "sha512-z"],`;
  expect([...lockfilePairs(lock)]).toEqual([
    ['@aztec-foundation/bb.js', [T]],
    ['@aztec-labs/stdlib', [T]],
    ['@aztec/viem', ['2.38.3']],
  ]);
});

test('the committed bun.lock resolves each Aztec scope only at its root config version', () => {
  const root = join(import.meta.dir, '..', '..');
  const config = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).config;
  const lockText = readFileSync(join(root, 'bun.lock'), 'utf8');
  expect(lockfilePairs(lockText).size).toBeGreaterThan(0);
  expect(lockfileScopeErrors(lockText, readAztecVersions(config))).toEqual([]);
});
