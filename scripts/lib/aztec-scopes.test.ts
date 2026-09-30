import { describe, expect, test } from 'bun:test';

import { AZTEC_NR_GIT, closureEdge, lockfilePairs, parseAlias, sweepNargoLine, youngNames } from './aztec-scopes.ts';

const T = '6.0.0-rc.1';

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
    expect(closureEdge('p', '@aztec-labs/stdlib', T, T)).toEqual({ name: '@aztec-labs/stdlib', version: T });
    expect(closureEdge('p', 'viem', 'npm:@aztec/viem@2.38.3', T)).toEqual({ name: '@aztec/viem', version: '2.38.3' });
    expect(closureEdge('p', 'lodash', '4.17.21', T)).toBeUndefined();
  });

  test('a foundation dep pinned off-target fails loudly', () => {
    const r = closureEdge('@aztec-labs/aztec.js', '@aztec-foundation/l1-artifacts', '6.0.0-rc.2', T);
    expect(r).toEqual({ error: expect.stringMatching(/upstream versions diverged/) });
  });

  test('ranges and aliases must actually resolve to the target', () => {
    const diverged = { error: expect.stringMatching(/upstream versions diverged/) };
    expect(closureEdge('p', '@aztec-labs/stdlib', `^${T}`, T)).toEqual({ name: '@aztec-labs/stdlib', version: T });
    expect(closureEdge('p', '@aztec-labs/stdlib', '^5.0.1', T)).toEqual(diverged);
    expect(closureEdge('p', 'bb', 'npm:@aztec-foundation/bb.js@5.0.1', T)).toEqual(diverged);
    expect(closureEdge('p', 'bb', 'npm:@aztec-foundation/bb.js', T)).toEqual(diverged);
    expect(closureEdge('p', 'viem', 'npm:@aztec/viem', T)).toEqual({ error: expect.stringMatching(/not an exact/) });
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
