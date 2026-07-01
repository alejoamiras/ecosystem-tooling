import { Fr } from '@aztec/aztec.js/fields';
import type { AztecNode } from '@aztec/aztec.js/node';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import { FeeJuiceContract } from '@aztec/noir-contracts.js/FeeJuice';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { EmbeddedWallet } from '@aztec/wallets/embedded';
import { beforeAll, describe, expect, it } from 'vitest';

import type { PrivateFPCContract } from '../../artifacts/PrivateFPC.js';
import { FPCFeePaymentMethod } from '../fee-payment-methods/index.js';
import { registerPrivateContract } from '../utils/deploy.js';
import { estimateGasSettings, maxGasCostFor } from '../utils/gas.js';

import {
  bridgeForMint,
  createLocalNetworkContext,
  fundL2AddressWithFeeJuiceFromL1,
  LOCAL_AZTEC_NODE_URL,
} from './harness.js';

import { deployCounter, TEST_SALT, TEST_TIMEOUT } from './utils.js';

describe('Private FPC', () => {
  let wallet: EmbeddedWallet;
  let alice: AztecAddress;
  let bob: AztecAddress;
  let aztecNode: AztecNode;
  let fpc: PrivateFPCContract;
  let paymentMethod: FPCFeePaymentMethod;

  beforeAll(async () => {
    const ctx = await createLocalNetworkContext({
      nodeUrl: LOCAL_AZTEC_NODE_URL,
      wallet: { dataDirectory: 'pxe-test-private', proverEnabled: false },
    });
    aztecNode = ctx.aztecNode;
    wallet = ctx.wallet;
    alice = ctx.deployer;
    bob = ctx.accounts[1]!;

    // Register the PrivateFPC — no deployment transaction needed (fully private contract).
    fpc = await registerPrivateContract(wallet, TEST_SALT);

    // Fund the FPC's public FeeJuice balance so it can pay sequencers.
    // This uses a random internal secret (not the claimer-bound bridge flow).
    const { balance } = await fundL2AddressWithFeeJuiceFromL1(aztecNode, wallet, fpc.address, {
      claimTxSender: alice,
      produceL2Block: async () => {
        await deployCounter(wallet);
      },
      loggerName: 'test:private-fpc-fund',
    });
    expect(balance).toBeGreaterThan(0n);

    paymentMethod = new FPCFeePaymentMethod(fpc.address);
  });

  // --- mint success → pay_fee ---
  // Both behaviors are tested in sequence within a single test: mint credits
  // a FJ balance that pay_fee immediately consumes. Splitting would require a second
  // L1→L2 bridge round-trip purely for setup, making the suite significantly slower
  // without adding meaningful isolation.

  it(
    'mint SUCCESS → pay_fee: bridge claim credited as FJ, sponsors tx',
    async () => {
      const counter = await deployCounter(wallet);
      const salt = Fr.random();

      // Step 1: Bridge from L1 with alice's claimer-bound secret.
      const { secret, claimAmount, leafIndex } = await bridgeForMint(
        aztecNode,
        fpc.address,
        alice,
        salt,
        async () => {
          await deployCounter(wallet);
        },
        { loggerName: 'test:private-mint-success' },
      );

      // Step 2: Claim FeeJuice on L2 — credits FPC's public FeeJuice balance
      //         and emits the FeeJuice nullifier.
      const feeJuice = FeeJuiceContract.at(ProtocolContractAddress.FeeJuice, wallet);
      await feeJuice.methods.claim(fpc.address, claimAmount, secret, leafIndex).send({ from: alice });

      // Step 3: Mint internal FJ balance by proving the FeeJuice nullifier exists.
      const { result: balanceBefore } = await fpc.methods.balance_of(alice).simulate({ from: alice });

      await fpc.methods.mint(claimAmount, salt, leafIndex).send({ from: alice });

      const { result: balanceAfter } = await fpc.methods.balance_of(alice).simulate({ from: alice });

      expect(balanceAfter).toBe(balanceBefore + BigInt(claimAmount));

      // Step 4: Sponsor a counter increment using the FJ balance.
      const fpcFeeJuiceBefore = await getFeeJuiceBalance(fpc.address, aztecNode);
      const { result: internalBalanceBefore } = await fpc.methods.balance_of(alice).simulate({ from: alice });

      const gasSettings = await estimateGasSettings(counter.methods.increment(), {
        aztecNode,
        from: alice,
        paymentMethod,
      });
      const maxGasCost = maxGasCostFor(gasSettings.maxFeesPerGas, gasSettings.gasLimits);

      const { receipt } = await counter.methods.increment().send({
        from: alice,
        fee: {
          paymentMethod,
          gasSettings,
        },
      });

      expect(receipt.isMined()).toBe(true);
      expect(receipt.hasExecutionSucceeded()).toBe(true);

      const fpcFeeJuiceAfter = await getFeeJuiceBalance(fpc.address, aztecNode);
      const { result: internalBalanceAfter } = await fpc.methods.balance_of(alice).simulate({ from: alice });

      // FPC paid sequencer from its public FeeJuice balance.
      expect(fpcFeeJuiceAfter).toBeLessThan(fpcFeeJuiceBefore);
      // Alice's internal FJ balance decreased by max gas cost (no refund).
      expect(internalBalanceAfter).toBe(internalBalanceBefore - maxGasCost);
    },
    TEST_TIMEOUT,
  );

  // --- mint double-spend ---

  it(
    'mint double-spend REVERT: second call with same leaf_index fails',
    async () => {
      const salt = Fr.random();

      // Bridge from L1.
      const { secret, claimAmount, leafIndex } = await bridgeForMint(
        aztecNode,
        fpc.address,
        alice,
        salt,
        async () => {
          await deployCounter(wallet);
        },
        { loggerName: 'test:private-double-spend' },
      );

      // Claim FeeJuice on L2.
      const feeJuice = FeeJuiceContract.at(ProtocolContractAddress.FeeJuice, wallet);
      await feeJuice.methods.claim(fpc.address, claimAmount, secret, leafIndex).send({ from: alice });

      // First mint succeeds.
      await fpc.methods.mint(claimAmount, salt, leafIndex).send({ from: alice });

      // Second mint with the same parameters must fail —
      // the FPC-scoped nullifier is already emitted.
      await expect(
        fpc.methods.mint(claimAmount, salt, leafIndex).send({
          from: alice,
        }),
      ).rejects.toThrow();
    },
    TEST_TIMEOUT,
  );

  // --- mint wrong claimer ---

  it(
    "mint wrong claimer REVERT: bob cannot claim alice's bridge deposit",
    async () => {
      const salt = Fr.random();

      // Alice bridges from L1 with her claimer-bound secret.
      const { secret, claimAmount, leafIndex } = await bridgeForMint(
        aztecNode,
        fpc.address,
        alice,
        salt,
        async () => {
          await deployCounter(wallet);
        },
        { loggerName: 'test:private-wrong-claimer' },
      );

      // Claim FeeJuice on L2 (claim itself works — it credits FPC's public balance).
      const feeJuice = FeeJuiceContract.at(ProtocolContractAddress.FeeJuice, wallet);
      await feeJuice.methods.claim(fpc.address, claimAmount, secret, leafIndex).send({ from: alice });

      // Bob tries to call mint with the same (salt, leafIndex) but as msg_sender=bob.
      // Bob's reconstructed FeeJuice nullifier (using bob's address) doesn't match the one
      // that FeeJuice.claim emitted (which used alice's address), so the existence check fails.
      await expect(
        fpc.methods.mint(claimAmount, salt, leafIndex).send({
          from: bob,
        }),
      ).rejects.toThrow();
    },
    TEST_TIMEOUT,
  );
});
