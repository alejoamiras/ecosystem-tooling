import {
  Benchmark,
  type BenchmarkContext,
  type FeeGasSettings,
  type NamedBenchmarkedInteraction,
  namedMethod,
} from '@alejoamiras/aztec-benchmark';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { type AztecNode, createAztecNodeClient, waitForNode } from '@aztec/aztec.js/node';
import { Barretenberg } from '@aztec/bb.js';
import { FeeJuiceContract } from '@aztec/noir-contracts.js/FeeJuice';
import type { SimpleTokenContract } from '@aztec/noir-contracts.js/SimpleToken';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';
import { getPXEConfig } from '@aztec/pxe/config';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { registerInitialLocalNetworkAccountsInWallet } from '@aztec/wallets/testing';
import { z } from 'zod';

import type { PrivateFPCContract } from '../src/artifacts/PrivateFPC.js';
import { FPCFeePaymentMethod, PrivateMintAndPayFeePaymentMethod } from '../src/ts/fee-payment-methods/index.js';
import { bridgeForMint, fundL2AddressWithFeeJuiceFromL1 } from '../src/ts/test/harness.js';
import { deploySponsoredApp, produceL2Block, TEST_SALT } from '../src/ts/test/utils.js';
import { registerPrivateContract } from '../src/ts/utils/deploy.js';
import { estimateGasSettings } from '../src/ts/utils/gas.js';

const { NODE_URL } = z.object({ NODE_URL: z.string().url().default('http://localhost:8080') }).parse(process.env);
const node: AztecNode = createAztecNodeClient(NODE_URL);
await waitForNode(node);
const pxeConfig = getPXEConfig();

interface PrivateBenchmarkContext extends BenchmarkContext {
  cleanup: () => Promise<void>;
  wallet: EmbeddedWallet;
  deployer: AztecAddress;
  // Stock upstream SimpleToken standing in as the sponsored application (replaces the
  // former local Counter). The FPC sponsors a `mint_privately` on it.
  token: SimpleTokenContract;
  privateFpc: PrivateFPCContract;
  privatePaymentMethod: FPCFeePaymentMethod;
  mintAndPayFeeMethod: PrivateMintAndPayFeePaymentMethod;
  // Pre-bridged deposit kept for the mint_and_pay_fee benchmark method.
  // The L1 deposit is done in setup; FeeJuice.claim + mint_and_pay_fee
  // happen atomically inside the benchmark interaction itself.
  mintAndPayFeeDeposit: {
    secret: Fr;
    salt: Fr;
    leafIndex: Fr;
    amount: bigint;
  };
  // Pre-bridged deposit for the standalone mint benchmark.
  // FeeJuice.claim is settled in setup; only mint runs in the benchmark.
  mintPrivateDeposit: {
    secret: Fr;
    salt: Fr;
    leafIndex: Fr;
    amount: bigint;
  };
  mintPrivatelyFpcGasSettings: FeeGasSettings;
  mintPrivatelyMintAndPayFeeGasSettings: FeeGasSettings;
}

export default class PrivateFPCBenchmark extends Benchmark {
  /**
   * Sets up the benchmark environment for the PrivateFPC contract.
   *
   * Registers the fully-private PrivateFPC (no deployment tx), funds its
   * public FeeJuice balance for sequencer payments, then performs a full
   * L1→L2 bridge + FeeJuice.claim + mint cycle so the deployer
   * has internal FJ balance ready for the pay_fee benchmark methods.
   */
  async setup(): Promise<PrivateBenchmarkContext> {
    await Barretenberg.destroySingleton();

    const wallet = await EmbeddedWallet.create(node, {
      ephemeral: true,
      pxeConfig: {
        ...pxeConfig,
        proverEnabled: false,
      },
    });
    const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);
    const [deployer] = accounts;

    const cleanup = async () => {
      await wallet.stop();
    };

    // Deploy the sponsored-app token (stock upstream SimpleToken).
    const token = await deploySponsoredApp(wallet);

    // Register PrivateFPC — fully private, no on-chain deployment tx required.
    const privateFpc = await registerPrivateContract(wallet, TEST_SALT);

    // Fund the FPC's public FeeJuice balance so it can pay sequencers.
    await fundL2AddressWithFeeJuiceFromL1(node, wallet, privateFpc.address, {
      claimTxSender: deployer,
      produceL2Block: async () => {
        await produceL2Block(wallet, token);
      },
      loggerName: 'benchmark:private-fund',
    });

    // Bridge 1: fund internal FJ balance for the pay_fee benchmark methods.
    // FeeJuice.claim + mint happen here so the balance is ready at benchmark time.
    const saltForBalance = Fr.random();
    const {
      secret: secretForBalance,
      claimAmount,
      leafIndex: leafIndexForBalance,
    } = await bridgeForMint(
      node,
      privateFpc.address,
      AztecAddress.fromStringUnsafe(deployer.toString()),
      saltForBalance,
      async () => {
        await produceL2Block(wallet, token);
      },
      { loggerName: 'benchmark:private-bridge-balance' },
    );

    const feeJuice = FeeJuiceContract.at(ProtocolContractAddress.FeeJuice, wallet);
    await feeJuice.methods
      .claim(privateFpc.address, claimAmount, secretForBalance, leafIndexForBalance)
      .send({ from: deployer });

    await privateFpc.methods.mint(claimAmount, saltForBalance, leafIndexForBalance).send({ from: deployer });

    // Bridge 2: reserved for the mint_and_pay_fee benchmark method.
    // Only the L1 deposit is done here; FeeJuice.claim + mint_and_pay_fee
    // execute atomically inside the benchmark interaction itself.
    const saltForMintAndPay = Fr.random();
    const {
      secret: secretForMintAndPay,
      claimAmount: claimAmountForMintAndPay,
      leafIndex: leafIndexForMintAndPay,
    } = await bridgeForMint(
      node,
      privateFpc.address,
      AztecAddress.fromStringUnsafe(deployer.toString()),
      saltForMintAndPay,
      async () => {
        await produceL2Block(wallet, token);
      },
      { loggerName: 'benchmark:private-bridge-mint-and-pay' },
    );

    const privatePaymentMethod = new FPCFeePaymentMethod(privateFpc.address);

    const mintAndPayFeeMethod = new PrivateMintAndPayFeePaymentMethod(
      privateFpc.address,
      claimAmountForMintAndPay,
      secretForMintAndPay,
      saltForMintAndPay,
      leafIndexForMintAndPay,
    );

    const mintPrivatelyFpcGasSettings = await estimateGasSettings(
      token.withWallet(wallet).methods.mint_privately(deployer, deployer, 1n),
      {
        aztecNode: node,
        from: deployer,
        paymentMethod: privatePaymentMethod,
      },
    );

    const mintPrivatelyMintAndPayFeeGasSettings = await estimateGasSettings(
      token.withWallet(wallet).methods.mint_privately(deployer, deployer, 1n),
      {
        aztecNode: node,
        from: deployer,
        paymentMethod: mintAndPayFeeMethod,
      },
    );

    // Bridge 3: for the standalone mint benchmark.
    // FeeJuice.claim is settled here so the nullifier exists on-chain before
    // the benchmark runs. Only mint itself is exercised in the benchmark.
    const saltForMintPrivate = Fr.random();
    const {
      secret: secretForMintPrivate,
      claimAmount: claimAmountForMintPrivate,
      leafIndex: leafIndexForMintPrivate,
    } = await bridgeForMint(
      node,
      privateFpc.address,
      AztecAddress.fromStringUnsafe(deployer.toString()),
      saltForMintPrivate,
      async () => {
        await produceL2Block(wallet, token);
      },
      { loggerName: 'benchmark:private-bridge-mint-private' },
    );

    await feeJuice.methods
      .claim(privateFpc.address, claimAmountForMintPrivate, secretForMintPrivate, leafIndexForMintPrivate)
      .send({ from: deployer });

    return {
      cleanup,
      wallet,
      deployer,
      token,
      privateFpc,
      privatePaymentMethod,
      mintAndPayFeeMethod,
      mintAndPayFeeDeposit: {
        secret: secretForMintAndPay,
        salt: saltForMintAndPay,
        leafIndex: leafIndexForMintAndPay,
        amount: claimAmountForMintAndPay,
      },
      mintPrivateDeposit: {
        secret: secretForMintPrivate,
        salt: saltForMintPrivate,
        leafIndex: leafIndexForMintPrivate,
        amount: claimAmountForMintPrivate,
      },
      mintPrivatelyFpcGasSettings,
      mintPrivatelyMintAndPayFeeGasSettings,
    };
  }

  getMethods(context: PrivateBenchmarkContext): NamedBenchmarkedInteraction[] {
    const {
      token,
      wallet,
      deployer,
      privateFpc,
      privatePaymentMethod,
      mintAndPayFeeMethod,
      mintPrivateDeposit,
      mintPrivatelyFpcGasSettings,
      mintPrivatelyMintAndPayFeeGasSettings,
    } = context;

    // Methods ordered so note state flows correctly:
    //   1. simple_token_mint_privately              -- baseline sponsored app op, no FPC
    //   2. mint_private                             -- standalone mint (bridge-claim proof; nullifier
    //                                                  pre-settled in setup, no fee sponsorship)
    //   3. simple_token_mint_privately_fpc          -- pay_fee from existing FJ balance
    //                                                  (funded by mint in setup)
    //   4. simple_token_mint_privately_fpc_mint_and_pay_fee -- FeeJuice.claim + mint_and_pay_fee
    //                                                  in one tx (cold-start, no prior balance)
    return [
      namedMethod(
        'simple_token_mint_privately',
        deployer,
        token.withWallet(wallet).methods.mint_privately(deployer, deployer, 1n),
      ),
      // Standalone mint: benchmarks the bridge-claim proof in isolation.
      // FeeJuice.claim was settled in setup, so assert_nullifier_exists sees a
      // settled nullifier. No FPC fee sponsorship — deployer pays native FeeJuice.
      namedMethod(
        'mint_private',
        deployer,
        privateFpc
          .withWallet(wallet)
          .methods.mint(mintPrivateDeposit.amount, mintPrivateDeposit.salt, mintPrivateDeposit.leafIndex),
      ),
      namedMethod(
        'simple_token_mint_privately_fpc',
        deployer,
        token.withWallet(wallet).methods.mint_privately(deployer, deployer, 1n),
        {
          paymentMethod: privatePaymentMethod,
          gasSettings: mintPrivatelyFpcGasSettings,
        },
      ),
      namedMethod(
        'simple_token_mint_privately_fpc_mint_and_pay_fee',
        deployer,
        token.withWallet(wallet).methods.mint_privately(deployer, deployer, 1n),
        {
          paymentMethod: mintAndPayFeeMethod,
          gasSettings: mintPrivatelyMintAndPayFeeGasSettings,
        },
      ),
    ];
  }

  async teardown(context: BenchmarkContext): Promise<void> {
    await (context as PrivateBenchmarkContext).cleanup();
  }
}
