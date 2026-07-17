import { Fr } from '@aztec/aztec.js/fields';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { SimpleTokenContract } from '@aztec/noir-contracts.js/SimpleToken';

/** Global test timeout constant for individual test cases. */
export const TEST_TIMEOUT = 300_000;

/** Fixed salt used for PrivateFPC in tests and benchmarks. */
export const TEST_SALT = Fr.ZERO;

/**
 * Deploys a stock upstream `SimpleToken` (from `@aztec/noir-contracts.js`, a demonstration
 * contract) to act as the private application transaction the FPC sponsors in the tests and
 * benchmark. It replaces the previously-bundled local `counter_contract`: a stock contract
 * needs no maintained Noir crate and ships nothing to consumers. SimpleToken is test-only —
 * never exported or bundled by this package.
 */
export async function deploySponsoredApp(deployer: Wallet): Promise<SimpleTokenContract> {
  const deployerAddress = (await deployer.getAccounts())[0]?.item;
  const { contract } = await SimpleTokenContract.deploy(deployer, 'FPC Test Token', 'FPT', 18).send({
    from: deployerAddress,
  });
  return contract;
}

/**
 * Forces an L2 block to be produced by submitting a transaction (a `mint_privately` — the
 * precondition-free private-entry op, so no prior balance / note-availability is required).
 * Use after L1 time warps to ensure the new timestamp is reflected in the L2 historical state
 * (e.g. for DelayedPublicMutable settlement).
 */
export async function produceL2Block(wallet: Wallet, token: SimpleTokenContract): Promise<void> {
  const from = (await wallet.getAccounts())[0]?.item;
  await token.methods.mint_privately(from, from, 1n).send({ from });
}
