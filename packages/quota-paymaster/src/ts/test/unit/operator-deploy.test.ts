/**
 * Deploy-time refusal paths, against the REAL installed artifacts — the checks
 * exist to catch version drift, so testing them against mocks would be
 * circular.
 */
import { getContractClassFromArtifact } from '@aztec/aztec.js/contracts';
import { describe, expect, test } from 'vitest';
import { assertArtifactIsChainVerifiedClass, verifyAccountClassIds } from '../../operator/deploy.js';

async function realInitializerlessClassId(): Promise<string> {
  const { SchnorrInitializerlessAccountContractArtifact } = await import('@aztec/accounts/schnorr');
  const { id } = await getContractClassFromArtifact(SchnorrInitializerlessAccountContractArtifact);
  return id.toString();
}

describe('verifyAccountClassIds', () => {
  test('a correct id for a known class verifies', async () => {
    const classId = await realInitializerlessClassId();
    const result = await verifyAccountClassIds([{ name: 'SchnorrInitializerlessAccount', classId }]);
    expect(result).toEqual({ verified: 1, unverified: 0 });
  });

  test('a stale id (different @aztec/accounts version) is refused with the expected id named', async () => {
    await expect(verifyAccountClassIds([{ name: 'SchnorrInitializerlessAccount', classId: '0x1234' }])).rejects.toThrow(
      /does not match the installed/,
    );
  });

  test('an unknown class name fails CLOSED — a typo cannot ship unchecked', async () => {
    await expect(verifyAccountClassIds([{ name: 'SchnorrInitializerlesAccount', classId: '0x1234' }])).rejects.toThrow(
      /Cannot verify account class/,
    );
  });

  test('allowUnverified ships an unknown name deliberately, and says so', async () => {
    const warnings: string[] = [];
    const result = await verifyAccountClassIds([{ name: 'MyCustomAccount', classId: '0x1234' }], true, (m) =>
      warnings.push(m),
    );
    expect(result).toEqual({ verified: 0, unverified: 1 });
    expect(warnings.some((w) => /UNVERIFIED/.test(w))).toBe(true);
  });
});

describe('deploy lineage guard', () => {
  test('the compiled artifact IS the chain-verified class (deploys refuse otherwise)', async () => {
    // Same anchor verify:lineage enforces; deployQuotaFpc re-asserts it so an
    // operator cannot deploy a locally drifted artifact.
    await expect(assertArtifactIsChainVerifiedClass()).resolves.toMatch(/^0x115cfdfd/);
  });
});
