import {
  type AztecNode,
  createAztecNodeClient,
  waitForNode,
} from "@aztec/aztec.js/node";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { isL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";
import { getPXEConfig } from "@aztec/pxe/config";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { L1FeeJuicePortalManager } from "@aztec/aztec.js/ethereum";
import { FeeJuiceContract } from "@aztec/noir-contracts.js/FeeJuice";
import { ProtocolContractAddress } from "@aztec/protocol-contracts";
import { Fr } from "@aztec/aztec.js/fields";
import {
  poseidon2HashBytes,
  poseidon2HashWithSeparator,
} from "@aztec/foundation/crypto/sync";
import { createLogger } from "@aztec/foundation/log";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { extractEvent } from "@aztec/ethereum/utils";
import { EthCheatCodes, RollupCheatCodes } from "@aztec/ethereum/test";
import { DateProvider } from "@aztec/foundation/timer";
import { FeeJuicePortalAbi } from "@aztec/l1-artifacts/FeeJuicePortalAbi";
import { computeSecretHash } from "@aztec/stdlib/hash";
import { getContract } from "viem";

export const LOCAL_AZTEC_NODE_URL = "http://localhost:8080";
const DEFAULT_L1_RPC_URL = "http://127.0.0.1:8545";

export type LocalNetworkContext = {
  aztecNode: AztecNode;
  wallet: EmbeddedWallet;
  accounts: AztecAddress[];
  deployer: AztecAddress;
};

export async function createLocalNetworkContext(opts?: {
  nodeUrl?: string;
  wallet?: { dataDirectory?: string; proverEnabled?: boolean };
  waitForNode?: boolean;
}): Promise<LocalNetworkContext> {
  const nodeUrl = opts?.nodeUrl ?? LOCAL_AZTEC_NODE_URL;
  const aztecNode = createAztecNodeClient(nodeUrl, {});
  if (opts?.waitForNode ?? true) {
    await waitForNode(aztecNode);
  }

  const pxeConfig = {
    ...getPXEConfig(),
    dataDirectory: opts?.wallet?.dataDirectory ?? "pxe-test",
    proverEnabled: opts?.wallet?.proverEnabled ?? false,
  };
  const wallet = await EmbeddedWallet.create(aztecNode, { pxeConfig });

  const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);
  const [deployer] = accounts;
  if (!deployer)
    throw new Error(
      "No local-network accounts returned by wallet registration.",
    );

  return { aztecNode, wallet, accounts, deployer };
}

export type FundFeeJuiceFromL1Options = {
  l1RpcUrls?: string[];
  l1Mnemonic?: string;
  loggerName?: string;
  claimTxSender: AztecAddress;
  produceL2Block: () => Promise<void>;
  messagePollTries?: number;
  messagePollIntervalMs?: number;
};

/**
 * Fund an L2 address with FeeJuice by bridging from L1.
 * This is the standard way to fund FPCs with the native fee token.
 */
export async function fundL2AddressWithFeeJuiceFromL1(
  aztecNode: Pick<AztecNode, "getL1ToL2MessageCheckpoint" | "getBlockData">,
  wallet: Wallet,
  recipient: AztecAddress,
  opts: FundFeeJuiceFromL1Options,
): Promise<{ balance: bigint }> {
  const logger = createLogger(opts.loggerName ?? "fee-juice");
  const l1Client = createExtendedL1Client(
    opts.l1RpcUrls ?? ["http://127.0.0.1:8545"],
    opts.l1Mnemonic ??
      "test test test test test test test test test test test junk",
  );

  const feeJuicePortal = await L1FeeJuicePortalManager.new(
    aztecNode as any,
    l1Client,
    logger,
  );
  const claim = await feeJuicePortal.bridgeTokensPublic(
    recipient,
    undefined,
    true,
  );

  const messageHash = Fr.fromString(claim.messageHash);
  const pollTries = opts.messagePollTries ?? 400;
  const pollIntervalMs = opts.messagePollIntervalMs ?? 10;

  let ready = false;
  for (let i = 0; i < pollTries; i++) {
    ready = await isL1ToL2MessageReady(aztecNode, messageHash);
    if (ready) break;
    await opts.produceL2Block();
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  if (!ready) {
    throw new Error(
      `L1->L2 message not yet ingested by node for FeeJuice deposit: ${claim.messageHash}`,
    );
  }

  const feeJuice = FeeJuiceContract.at(
    ProtocolContractAddress.FeeJuice,
    wallet,
  );
  await feeJuice.methods
    .claim(
      recipient,
      claim.claimAmount,
      claim.claimSecret,
      new Fr(claim.messageLeafIndex),
    )
    .send({ from: opts.claimTxSender });

  const { getFeeJuiceBalance } = await import("@aztec/aztec.js/utils");
  const balance = await getFeeJuiceBalance(recipient, aztecNode as any);
  return { balance };
}

/**
 * Domain separator for FPC bridge secret derivation — must match the Noir constant
 * `DOM_SEP__FPC_BRIDGE_SECRET` in private_contract/src/main.nr.
 * Computed as: poseidon2_hash_bytes("az_dom_sep__fpc_bridge_secret") as u32
 */
const DOM_SEP__FPC_BRIDGE_SECRET = Number(
  poseidon2HashBytes(Buffer.from("az_dom_sep__fpc_bridge_secret")).toBigInt() &
    0xffff_ffffn,
);

/** Result returned by bridgeForMint. */
export type BridgeForMintResult = {
  /** The bridge secret (poseidon2([salt, claimer], DOM_SEP)). Pass to FeeJuice.claim. */
  secret: Fr;
  /** Amount of FeeJuice bridged. */
  claimAmount: bigint;
  /** Leaf index of the L1→L2 message. Pass to FeeJuice.claim and mint. */
  leafIndex: Fr;
};

/**
 * Bridges FeeJuice from L1 to the PrivateFPC with a claimer-bound secret,
 * enabling the claimer to later call `mint` on L2.
 *
 * Flow:
 *   1. Derives `secret = poseidon2([salt, claimer], DOM_SEP__FPC_BRIDGE_SECRET)`
 *   2. Computes `secretHash = computeSecretHash(secret)`
 *   3. Mints + approves tokens on L1 (test-only)
 *   4. Calls `FeeJuicePortal.depositToAztecPublic(_to=fpcAddress, _amount, secretHash)`
 *   5. Polls until the L1→L2 message is ingested by the Aztec node
 *   6. Returns `{ secret, claimAmount, leafIndex }` for use in `FeeJuice.claim` + `mint`
 *
 * @param aztecNode     Aztec node client (for L1 contract addresses and message polling)
 * @param fpcAddress    The PrivateFPC contract address (the L1 deposit recipient)
 * @param claimer       The Aztec address of the user who will claim on L2
 * @param salt          A random value chosen by the claimer (used in secret derivation)
 * @param produceL2Block Callback to mine an L2 block (needed to advance past the message block)
 * @param opts          Optional L1 RPC URL, mnemonic, poll settings, logger name
 */
export async function bridgeForMint(
  aztecNode: Pick<
    AztecNode,
    "getL1ToL2MessageCheckpoint" | "getBlockData" | "getNodeInfo"
  >,
  fpcAddress: AztecAddress,
  claimer: AztecAddress,
  salt: Fr,
  produceL2Block: () => Promise<void>,
  opts?: {
    l1RpcUrls?: string[];
    l1Mnemonic?: string;
    loggerName?: string;
    messagePollTries?: number;
    messagePollIntervalMs?: number;
  },
): Promise<BridgeForMintResult> {
  const logger = createLogger(opts?.loggerName ?? "bridge-for-mint");

  // Derive the bridge secret (mirrors `derive_bridge_secret` in Noir).
  const secret = poseidon2HashWithSeparator(
    [salt, claimer],
    DOM_SEP__FPC_BRIDGE_SECRET,
  );
  const secretHash = await computeSecretHash(secret);

  const l1Client = createExtendedL1Client(
    opts?.l1RpcUrls ?? ["http://127.0.0.1:8545"],
    opts?.l1Mnemonic ??
      "test test test test test test test test test test test junk",
  );

  // Resolve portal + token addresses from the node.
  const {
    l1ContractAddresses: {
      feeJuicePortalAddress,
      feeJuiceAddress,
      feeAssetHandlerAddress,
    },
  } = await aztecNode.getNodeInfo();

  const handlerAddress =
    feeAssetHandlerAddress && !feeAssetHandlerAddress.isZero()
      ? feeAssetHandlerAddress
      : undefined;

  // Use the token manager from L1FeeJuicePortalManager to mint + approve.
  const feeJuiceManager = new L1FeeJuicePortalManager(
    feeJuicePortalAddress,
    feeJuiceAddress,
    handlerAddress,
    l1Client,
    logger,
  );
  const tokenManager = feeJuiceManager.getTokenManager();
  const claimAmount = await tokenManager.getMintAmount();

  // Mint tokens to the L1 account (test-only faucet).
  await tokenManager.mint(l1Client.account.address);
  // Approve the portal to spend the tokens.
  await tokenManager.approve(
    claimAmount,
    feeJuicePortalAddress.toString(),
    "FeeJuice Portal",
  );

  // Create a viem contract instance for the portal so we can call depositToAztecPublic
  // with our custom secretHash (bridgeTokensPublic generates its own random secret).
  const portalContract = getContract({
    address: feeJuicePortalAddress.toString() as `0x${string}`,
    abi: FeeJuicePortalAbi,
    client: l1Client,
  });

  const depositArgs = [
    fpcAddress.toString(),
    claimAmount,
    secretHash.toString(),
  ] as const;

  logger.info("Depositing to FeeJuice portal with claimer-bound secret");
  const txHash = await portalContract.write.depositToAztecPublic(depositArgs);
  const txReceipt = await l1Client.waitForTransactionReceipt({ hash: txHash });

  // Extract the DepositToAztecPublic event to get the message leaf index.
  const log = extractEvent(
    txReceipt.logs,
    feeJuicePortalAddress.toString(),
    FeeJuicePortalAbi,
    "DepositToAztecPublic",
    (l) =>
      l.args.amount === claimAmount &&
      l.args.to?.toLowerCase() === fpcAddress.toString().toLowerCase(),
    logger,
  );

  const messageHash = Fr.fromString(log.args.key as string);
  const leafIndex = new Fr(log.args.index as bigint);

  // Poll until the L1→L2 message is ready to be consumed.
  const pollTries = opts?.messagePollTries ?? 400;
  const pollIntervalMs = opts?.messagePollIntervalMs ?? 10;

  let ready = false;
  for (let i = 0; i < pollTries; i++) {
    ready = await isL1ToL2MessageReady(aztecNode, messageHash);
    if (ready) break;
    await produceL2Block();
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  if (!ready) {
    throw new Error(
      `L1→L2 message not yet ingested by node for PrivateFPC deposit: ${messageHash.toString()}`,
    );
  }

  logger.info(`PrivateFPC deposit ready, leafIndex=${leafIndex.toString()}`);
  return { secret, claimAmount, leafIndex };
}

/**
 * Advance L1 time.
 *
 * Warping L1 time skips L2 slots/epochs. Unproven blocks from skipped
 * epochs get pruned by the rollup, which the PXE detects as a reorg —
 * causing nullifier/note inconsistencies. To prevent this we mark all
 * pending blocks as proven before the warp, using RollupCheatCodes.
 *
 * The warp itself pauses all Anvil block production (automine + interval
 * mining) to avoid races where a background L1 tx consumes the pending
 * timestamp.
 *
 * @param aztecNode - The Aztec node client (used to fetch L1 contract addresses)
 * @param seconds - How many seconds to advance
 * @param l1RpcUrl - Anvil RPC endpoint (defaults to local 8545)
 */
export async function warpL1Time(
  aztecNode: Pick<AztecNode, "getL1ContractAddresses">,
  seconds: number,
  l1RpcUrl: string = DEFAULT_L1_RPC_URL,
): Promise<void> {
  const cc = new EthCheatCodes([l1RpcUrl], new DateProvider());
  const l1Addresses = await aztecNode.getL1ContractAddresses();
  const rollupCheatCodes = new RollupCheatCodes(cc, l1Addresses);

  // Mark all pending L2 blocks as proven so the rollup won't prune them
  // when L1 time jumps past the proof submission window.
  await rollupCheatCodes.markAsProven();

  // Warp with all block production paused to prevent races.
  await cc.execWithPausedAnvil(async () => {
    const before = await cc.lastBlockTimestamp();
    await cc.setNextBlockTimestamp(before + seconds);
    await cc.evmMine();
  });
}
