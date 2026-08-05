/**
 * Drift guards binding the TS SDK's mirrored values to their sources of truth.
 *
 * 1. Contract constants: the SDK mirrors several of the contract's globals
 *    (schema maxima, separators, day arithmetic). main.nr is hash-pinned by
 *    verify:lineage, so regexing ITS text is stable — a constant changed on
 *    either side fails here and names the pair.
 * 2. The account-entrypoint selector: the contract hardcodes a comptime
 *    signature string whose selector must equal the REAL entrypoint of the
 *    initializerless Schnorr account artifact. The TXE suite pins the string
 *    side to golden 0x9d57a239; this pins the ARTIFACT side to the same
 *    golden, so drift on either side trips exactly one test and names the
 *    culprit.
 * 3. GasProfile: fee-floor arithmetic mirrors the contract's billing formula.
 */
import { readFileSync } from 'node:fs';
import { SchnorrInitializerlessAccountContractArtifact } from '@aztec/accounts/schnorr';
import { FunctionSelector } from '@aztec/stdlib/abi';
import { describe, expect, test } from 'vitest';
import { MAX_ALLOWED_ACCOUNT_CLASSES, MAX_ALLOWED_TARGETS } from '../../config/schema.js';
import { DARK_FOREST_REFERENCE_GAS_PROFILE, sponsoredFeeFloorWei } from '../../gas-profile.js';
import { ROLLOVER_GRACE_SECONDS, SECONDS_PER_DAY } from '../../generation.js';
import { PLAYER_NULLIFIER_SEPARATOR, SEAT_NULLIFIER_SEPARATOR } from '../../nullifiers.js';
import { ACCOUNT_MAX_CALLS } from '../../sandwich.js';

const mainNr = readFileSync(new URL('../../../nr/quota_fpc/src/main.nr', import.meta.url), 'utf8');

function contractGlobal(name: string): bigint {
  const match = mainNr.match(new RegExp(`global ${name}: \\w+ = ([0-9_]+)`));
  if (!match) throw new Error(`global ${name} not found in main.nr`);
  return BigInt(match[1].replaceAll('_', ''));
}

describe('contract-constant mirrors', () => {
  test('every mirrored constant matches the vendored contract text', () => {
    expect(BigInt(MAX_ALLOWED_TARGETS)).toBe(contractGlobal('MAX_ALLOWED_TARGETS'));
    expect(BigInt(MAX_ALLOWED_ACCOUNT_CLASSES)).toBe(contractGlobal('MAX_ALLOWED_ACCOUNT_CLASSES'));
    expect(BigInt(ACCOUNT_MAX_CALLS)).toBe(contractGlobal('ACCOUNT_MAX_CALLS'));
    expect(SECONDS_PER_DAY).toBe(contractGlobal('SECONDS_PER_DAY'));
    expect(ROLLOVER_GRACE_SECONDS).toBe(contractGlobal('ROLLOVER_GRACE_SECONDS'));
    expect(BigInt(SEAT_NULLIFIER_SEPARATOR)).toBe(contractGlobal('SEAT_NULLIFIER_SEPARATOR'));
    expect(BigInt(PLAYER_NULLIFIER_SEPARATOR)).toBe(contractGlobal('PLAYER_NULLIFIER_SEPARATOR'));
  });
});

describe('account-entrypoint selector golden', () => {
  test('the initializerless Schnorr artifact still exposes entrypoint 0x9d57a239', async () => {
    const artifact = SchnorrInitializerlessAccountContractArtifact;
    const entrypoint = artifact.functions.find((fn) => fn.name === 'entrypoint');
    expect(entrypoint, 'the account artifact must have an entrypoint function').toBeDefined();
    const selector = await FunctionSelector.fromNameAndParameters(entrypoint?.name ?? '', entrypoint?.parameters ?? []);
    // Same golden the TXE suite asserts for the contract's comptime signature
    // string. If @aztec/accounts changes the entrypoint ABI, this fails; if
    // someone edits the contract's string, the TXE test fails.
    expect(selector.toString()).toBe('0x9d57a239');
  });
});

describe('fee-floor arithmetic', () => {
  test("mirrors the contract's billing formula (gas x fees, teardown NOT added)", () => {
    const profile = { ...DARK_FOREST_REFERENCE_GAS_PROFILE, feeHeadroomMultiplier: 1 };
    const floor = sponsoredFeeFloorWei(profile, 3n, 2n);
    expect(floor).toBe(BigInt(profile.daGasLimit) * 3n + BigInt(profile.l2GasLimit) * 2n);
    // Headroom multiplies the whole bound.
    expect(sponsoredFeeFloorWei({ ...profile, feeHeadroomMultiplier: 2 }, 3n, 2n)).toBe(floor * 2n);
  });

  test('invalid profiles are rejected loudly', () => {
    const profile = { ...DARK_FOREST_REFERENCE_GAS_PROFILE, daGasLimit: 0 };
    expect(() => sponsoredFeeFloorWei(profile, 1n, 1n)).toThrow(RangeError);
  });
});
