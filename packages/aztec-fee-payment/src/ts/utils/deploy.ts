import type { Fr } from '@aztec/aztec.js/fields';
import type { Wallet } from '@aztec/aztec.js/wallet';

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
 * @param wallet The wallet used to register the contract with the PXE
 * @param salt   Salt used to derive the contract address
 * @returns The registered PrivateFPC contract instance
 */
export async function registerPrivateContract(wallet: Wallet, salt: Fr): Promise<PrivateFPCContract> {
  return PrivateFPCContract.deploy(wallet, {
    salt,
    universalDeploy: true,
  }).register();
}
