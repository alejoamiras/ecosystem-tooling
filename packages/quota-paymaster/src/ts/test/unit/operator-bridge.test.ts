/**
 * bridgeFeeJuice's recipient validation — every rejection fires BEFORE any
 * dependency is touched, so null deps prove the ordering as well as the rule.
 */
import { describe, expect, test } from 'vitest';
import type { BridgeDeps } from '../../operator/bridge.js';
import { bridgeFeeJuice } from '../../operator/bridge.js';

const untouchedDeps = null as unknown as BridgeDeps;

describe('bridge recipient validation (pre-network)', () => {
  test('rejects a malformed address', async () => {
    await expect(bridgeFeeJuice(untouchedDeps, { to: '0x1234', amountWei: 1n })).rejects.toThrow(
      /not a 32-byte Aztec address/,
    );
  });

  test('rejects the zero address — the deposit would be lost', async () => {
    await expect(bridgeFeeJuice(untouchedDeps, { to: `0x${'0'.repeat(64)}`, amountWei: 1n })).rejects.toThrow(
      /zero address/,
    );
  });

  test('rejects a value at/above the field modulus — same burned-deposit class (review #1)', async () => {
    // 0xff…ff is a valid bytes32 the L1 portal would accept, but no Aztec
    // address can ever equal it, so the claim preimage can never match.
    await expect(bridgeFeeJuice(untouchedDeps, { to: `0x${'f'.repeat(64)}`, amountWei: 1n })).rejects.toThrow(
      /field element/,
    );
  });

  test('rejects a non-positive amount', async () => {
    const valid = `0x0${'3'.repeat(63)}`;
    await expect(bridgeFeeJuice(untouchedDeps, { to: valid, amountWei: 0n })).rejects.toThrow(
      /amountWei must be positive/,
    );
  });

  test('rejects an out-of-range gas buffer BEFORE any money moves (round-3 finding 5)', async () => {
    // Number.MAX_VALUE is finite, but scaling it to basis points overflows —
    // and would previously throw only AFTER the secret was journaled and the
    // L1 approval mined.
    const valid = `0x0${'3'.repeat(63)}`;
    for (const bad of [Number.MAX_VALUE, Number.POSITIVE_INFINITY, Number.NaN, -1, 10_001]) {
      await expect(
        bridgeFeeJuice(untouchedDeps, { to: valid, amountWei: 1n, gasLimitBufferPercent: bad }),
      ).rejects.toThrow(/gasLimitBufferPercent/);
    }
  });
});
