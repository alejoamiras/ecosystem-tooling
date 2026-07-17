import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import type { Wallet } from '@aztec/aztec.js/wallet';
// Static JSON import (NOT a runtime readFileSync): with tsconfig.build rootDir ".",
// tsc emits the JSON to dist/canonical-deployment.json and this specifier resolves
// from dist/src/ts/utils/deploy.js at runtime. The depth is ../../../ (utils -> ts
// -> src -> package root), matching src/ts/test/canonical.test.ts. A readFileSync
// copy would compute the path relative to dist/src/ts/utils at runtime and miss.
import canonicalDeployment from '../../../canonical-deployment.json' with { type: 'json' };
import { PrivateFPCContract } from '../../artifacts/PrivateFPC.js';

/**
 * Registers the PrivateFPC contract with the PXE without sending any deployment transaction.
 *
 * PrivateFPC is a fully private contract (no public functions, no constructor, no initializer).
 * The Aztec protocol allows interacting with such contracts immediately once registered —
 * no on-chain deployment transaction is required.
 *
 * The contract address is computed deterministically from its class hash and the provided salt.
 * `universalDeploy: true` zeroes the deployer in the address preimage, so the same salt always
 * produces the same address regardless of who calls this function. (Aztec 4.3 moved salt /
 * deployer / universalDeploy from per-call options into the `DeployMethod` instantiation
 * argument, and the `register()` method no longer accepts options.)
 *
 * @param wallet  The wallet used to register the contract with the PXE
 * @param salt    Salt used to derive the contract address
 * @param options `assertCanonical` (default false): when true, verify the salt and the derived
 *   address match the shipped `canonical-deployment.json` BEFORE registering — and throw
 *   (fail closed) on any mismatch, so a wrong salt/address never touches the PXE. Guards against
 *   silently registering (and later bridging funds to) a non-canonical address; a fully-private,
 *   constructor-less contract has no on-chain existence check to catch such a mistake.
 * @returns The registered PrivateFPC contract instance
 */
export async function registerPrivateContract(
  wallet: Wallet,
  salt: Fr,
  { assertCanonical = false }: { assertCanonical?: boolean } = {},
): Promise<PrivateFPCContract> {
  const deployMethod = PrivateFPCContract.deploy(wallet, {
    salt,
    universalDeploy: true,
  });

  if (assertCanonical) {
    // Fail closed BEFORE registering: check the salt, then the derived address
    // (getInstance() computes it with no side effects), then and only then register.
    const canonicalSalt = Fr.fromString(canonicalDeployment.salt);
    if (!salt.equals(canonicalSalt)) {
      throw new Error(
        `registerPrivateContract: salt ${salt.toString()} is not the canonical salt ` +
          `${canonicalDeployment.salt}. Refusing to register a non-canonical deployment (assertCanonical: true).`,
      );
    }
    const instance = await deployMethod.getInstance();
    // Semantic address equality (not raw string ===), symmetric with the salt's
    // .equals() above, so a serialization drift (e.g. checksum casing) can't make
    // the guard reject the CORRECT canonical address.
    if (!instance.address.equals(AztecAddress.fromStringUnsafe(canonicalDeployment.expectedAddress))) {
      throw new Error(
        `registerPrivateContract: derived address ${instance.address.toString()} does not match the canonical ` +
          `address ${canonicalDeployment.expectedAddress} for Aztec ${canonicalDeployment.aztecVersion}. ` +
          'Refusing to register (assertCanonical: true).',
      );
    }
  }

  return deployMethod.register();
}
