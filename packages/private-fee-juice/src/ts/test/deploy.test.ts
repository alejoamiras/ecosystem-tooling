import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { afterEach, describe, expect, it, vi } from 'vitest';
import canonical from '../../../canonical-deployment.json' with { type: 'json' };
import { PrivateFPCContract } from '../../artifacts/PrivateFPC.js';
import { registerPrivateContract } from '../utils/deploy.js';

// Unit tests for the F-002 `assertCanonical` guard. They stub PrivateFPCContract.deploy
// so the guard's LOGIC (fail-closed sequencing, no PXE mutation on mismatch) is tested
// without a live network. The REAL address derivation (does the compiled artifact yield
// the canonical address) is covered by canonical.test.ts + the dist-resolution gate.

const CANONICAL_SALT = Fr.fromString(canonical.salt);
const NON_CANONICAL_SALT = Fr.fromString('0x0000000000000000000000000000000000000000000000000000000000000002');

/** A stub DeployMethod whose getInstance() returns a real AztecAddress (so the guard's
 *  semantic `.equals()` comparison runs against a genuine field-backed address). */
function stubDeploy(addressString: string) {
  const registeredContract = {} as PrivateFPCContract;
  const deployMethod = {
    getInstance: vi.fn().mockResolvedValue({ address: AztecAddress.fromStringUnsafe(addressString) }),
    register: vi.fn().mockResolvedValue(registeredContract),
  };
  const wallet = {} as Parameters<typeof registerPrivateContract>[0];
  const spy = vi.spyOn(PrivateFPCContract, 'deploy').mockReturnValue(deployMethod as never);
  return { deployMethod, wallet, spy, registeredContract };
}

describe('registerPrivateContract assertCanonical guard (F-002)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers when the canonical salt derives the canonical address', async () => {
    const { deployMethod, wallet, registeredContract } = stubDeploy(canonical.expectedAddress);
    const result = await registerPrivateContract(wallet, CANONICAL_SALT, { assertCanonical: true });
    expect(deployMethod.getInstance).toHaveBeenCalledOnce();
    expect(deployMethod.register).toHaveBeenCalledOnce();
    expect(result).toBe(registeredContract);
  });

  it('throws on a non-canonical salt and never derives or registers', async () => {
    const { deployMethod, wallet } = stubDeploy(canonical.expectedAddress);
    await expect(registerPrivateContract(wallet, NON_CANONICAL_SALT, { assertCanonical: true })).rejects.toThrow(
      /is not the canonical salt/,
    );
    // Fail closed BEFORE derivation and BEFORE any PXE mutation.
    expect(deployMethod.getInstance).not.toHaveBeenCalled();
    expect(deployMethod.register).not.toHaveBeenCalled();
  });

  it('throws on a derived-address mismatch and never registers', async () => {
    // Canonical salt but the derivation yields a wrong address (the only way to reach
    // the address-mismatch branch — a wrong salt is rejected earlier).
    const wrongAddress = '0x00000000000000000000000000000000000000000000000000000000deadbeef';
    const { deployMethod, wallet } = stubDeploy(wrongAddress);
    await expect(registerPrivateContract(wallet, CANONICAL_SALT, { assertCanonical: true })).rejects.toThrow(
      /does not match the canonical address/,
    );
    expect(deployMethod.getInstance).toHaveBeenCalledOnce();
    expect(deployMethod.register).not.toHaveBeenCalled();
  });

  it('without the flag, registers any salt unchanged (no canonical check)', async () => {
    // Any valid address — never inspected without the flag (getInstance isn't called).
    const { deployMethod, wallet } = stubDeploy('0x00000000000000000000000000000000000000000000000000000000deadbeef');
    await registerPrivateContract(wallet, NON_CANONICAL_SALT);
    expect(deployMethod.getInstance).not.toHaveBeenCalled();
    expect(deployMethod.register).toHaveBeenCalledOnce();
  });
});
