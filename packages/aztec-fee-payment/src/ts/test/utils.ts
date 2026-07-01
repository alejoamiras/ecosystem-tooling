import { Fr } from '@aztec/aztec.js/fields';
import type { Wallet } from '@aztec/aztec.js/wallet';

import { CounterContract } from '../../artifacts/Counter.js';

/** Global test timeout constant for individual test cases. */
export const TEST_TIMEOUT = 300_000;

/** Fixed salt used for PrivateFPC in tests and benchmarks. */
export const TEST_SALT = Fr.ZERO;

/** Deploys the Counter contract. */
export async function deployCounter(deployer: Wallet): Promise<CounterContract> {
  const deployerAddress = (await deployer.getAccounts())[0]?.item;
  const { contract } = await CounterContract.deploy(deployer).send({
    from: deployerAddress,
  });
  return contract;
}

/**
 * Forces an L2 block to be produced by submitting a transaction.
 * Use after L1 time warps to ensure the new timestamp is reflected
 * in the L2 historical state (e.g. for DelayedPublicMutable settlement).
 */
export async function produceL2Block(wallet: Wallet): Promise<void> {
  await deployCounter(wallet);
}
