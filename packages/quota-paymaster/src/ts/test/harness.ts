/**
 * Integration harness: a live local Aztec network, the real compiled contracts,
 * and this package's own client code. Nothing is mocked.
 *
 * Network endpoints follow the repo convention: NODE_URL (default
 * http://localhost:8080) and L1_RPC_URL (default http://127.0.0.1:8545). The
 * warp suite OVERRIDES both via its self-provisioned network's env.
 */
import { createAztecNodeClient, waitForNode, waitForTx } from '@aztec/aztec.js/node';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import { DefaultEntrypoint } from '@aztec/entrypoints/default';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import { Gas, GasSettings } from '@aztec/stdlib/gas';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';
import type { ExecutionPayload } from '@aztec/stdlib/tx';

export const NODE_URL = process.env.NODE_URL ?? 'http://localhost:8080';
export const L1_RPC_URL = process.env.L1_RPC_URL ?? 'http://127.0.0.1:8545';

/**
 * Per-transaction gas ceilings the suite builds with (the reference profile's
 * shape). The data-gas cap is far tighter than the L2 cap and easy to blow.
 */
export const GAS_LIMITS = new Gas(50_000, 6_000_000);
export const TEARDOWN_GAS_LIMITS = new Gas(5_000, 500_000);

/* eslint-disable @typescript-eslint/no-explicit-any -- the wallet surface used
 * here (EmbeddedWallet + testing helpers) is version-loose by design. */

export interface Ctx {
  node: AztecNode;
  // biome-ignore lint/suspicious/noExplicitAny: EmbeddedWallet's full surface is not typed against the Wallet interface at 5.0.1
  wallet: any;
  addresses: AztecAddress[];
}

export async function connect(): Promise<Ctx> {
  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { registerInitialLocalNetworkAccountsInWallet } = await import('@aztec/wallets/testing');

  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
  // biome-ignore lint/suspicious/noExplicitAny: see Ctx.wallet
  const addresses = await registerInitialLocalNetworkAccountsInWallet(wallet as any);
  // biome-ignore lint/suspicious/noExplicitAny: see Ctx.wallet
  return { node, wallet: wallet as any, addresses };
}

export async function chainTimestamp(node: AztecNode): Promise<bigint> {
  const block = await node.getBlockData('latest');
  return BigInt(block?.header?.globalVariables?.timestamp ?? 0);
}

/**
 * Moves the chain to just after the next UTC midnight. Allowance notes are
 * keyed to a generation (a UTC day), so warp tests start a fresh day to be
 * deterministic rather than clock-dependent. WARP SUITE ONLY: warping is
 * global and irreversible; never point this at a shared network.
 */
export async function warpChainToDayStart(node: AztecNode, poke?: () => Promise<unknown>): Promise<bigint> {
  const DAY = 86_400n;
  const now = await chainTimestamp(node);
  const target = (now / DAY + 1n) * DAY + 60n;
  await warpChainTo(node, Number(target), poke);
  return chainTimestamp(node);
}

async function debugClient() {
  const { createAztecNodeDebugClient } = await import('@aztec/stdlib/interfaces/client');
  // biome-ignore lint/suspicious/noExplicitAny: the debug client's warp surface is untyped
  return createAztecNodeDebugClient(NODE_URL) as any;
}

async function warpChainTo(node: AztecNode, target: number, poke?: () => Promise<unknown>) {
  const debug = await debugClient();
  await debug.warpL2TimeAtLeastTo(target);
  // The warp moves the clock, but a block still has to be built for the new
  // time to be observable — an idle local chain produces none on its own.
  if (poke) await poke();
}

/** Fast-forwards the local chain by at least `seconds`. WARP SUITE ONLY. */
export async function warpChainBy(node: AztecNode, seconds: number, poke?: () => Promise<unknown>): Promise<bigint> {
  const before = await chainTimestamp(node);
  const debug = await debugClient();
  if (typeof debug.warpL2TimeAtLeastBy !== 'function') {
    throw new Error('This node exposes no warpL2TimeAtLeastBy; the warp suite needs a local network.');
  }
  await debug.warpL2TimeAtLeastBy(seconds);
  if (poke) await poke();
  const after = await chainTimestamp(node);
  if (after < before + BigInt(seconds)) {
    throw new Error(`Warp did not take: ${before} -> ${after}, expected at least +${seconds}s`);
  }
  return after;
}

export async function feeJuiceOf(node: AztecNode, address: AztecAddress): Promise<bigint> {
  return BigInt((await getFeeJuiceBalance(address, node)) ?? 0n);
}

export function evidence(tag: string, detail: unknown) {
  console.log(`EVIDENCE[${tag}] ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

/**
 * Sends a payload whose origin is the paymaster rather than an account.
 * This is the step the standard wallet flow cannot do for us.
 */
export async function sendFromPaymaster(
  ctx: Ctx,
  payload: ExecutionPayload,
  /** Whose notes the PXE must be able to decrypt — the sponsored USER, not the
   * paymaster: the allowance note is delivered to them. */
  scope: AztecAddress,
) {
  const chainInfo = await ctx.wallet.getChainInfo();
  const gasSettings = GasSettings.fallback({
    gasLimits: GAS_LIMITS,
    teardownGasLimits: TEARDOWN_GAS_LIMITS,
    maxFeesPerGas: await ctx.node.getCurrentMinFees(),
  });
  const txRequest = await new DefaultEntrypoint().createTxExecutionRequest(payload, gasSettings, chainInfo);
  const proven = await ctx.wallet.pxe.proveTx(txRequest, { scopes: [scope] });
  const tx = await proven.toTx();
  await ctx.node.sendTx(tx);

  // Wait for inclusion before returning: callers assert on resulting state, and
  // reading it before the block lands produces confusing phantom failures.
  const txHash = tx.getTxHash();
  const receipt = await waitForTx(ctx.node, txHash);
  return { txHash, receipt };
}

/** Bridges fee juice from L1 and claims it on L2 — the real funding path. */
export async function fundWithFeeJuice(
  node: AztecNode,
  // biome-ignore lint/suspicious/noExplicitAny: see Ctx.wallet
  wallet: any,
  recipient: AztecAddress,
  amount: bigint,
  claimFrom: AztecAddress,
  poke?: () => Promise<unknown>,
) {
  const { L1FeeJuicePortalManager } = await import('@aztec/aztec.js/ethereum');
  const { createEthereumChain } = await import('@aztec/ethereum/chain');
  const { createExtendedL1Client } = await import('@aztec/ethereum/client');
  const { FeeJuiceContract } = await import('@aztec/aztec.js/protocol');
  const { createLogger } = await import('@aztec/foundation/log');
  const { isL1ToL2MessageReady } = await import('@aztec/aztec.js/messaging');

  const info = await node.getNodeInfo();
  // TEST-ONLY, LOCAL-ONLY: anvil's well-known first default key, guarded by
  // the local chain id so it can never be pointed at a real network.
  if (info.l1ChainId !== 31337) {
    throw new Error(`fundWithFeeJuice is local-only (anvil); refusing l1ChainId ${info.l1ChainId}`);
  }
  const chain = createEthereumChain([L1_RPC_URL], info.l1ChainId);
  const l1Client = createExtendedL1Client(
    chain.rpcUrls,
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    chain.chainInfo,
  );
  const portal = await L1FeeJuicePortalManager.new(node, l1Client, createLogger('quota-paymaster:test-bridge'));
  const claim = await portal.bridgeTokensPublic(recipient, amount, true);

  // This network only builds blocks when transactions arrive, so an idle chain
  // never matures the L1->L2 message; poke it until the message is ready.
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await isL1ToL2MessageReady(node, Fr.fromString(claim.messageHash.toString()))) break;
    if (poke) await poke();
    await new Promise((r) => setTimeout(r, 1500));
  }

  await FeeJuiceContract.at(wallet)
    .methods.claim(recipient, claim.claimAmount, Fr.fromString(claim.claimSecret.toString()), claim.messageLeafIndex)
    .send({ from: claimFrom });
}

export const randomNonce = () => Fr.random();
