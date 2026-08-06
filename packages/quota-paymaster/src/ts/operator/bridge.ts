/**
 * Bridges L1 $AZTEC into Aztec fee juice — genuinely one-way: fee juice cannot
 * be moved or withdrawn once it lands, by anyone, ever.
 *
 * WHY THIS DOES NOT CALL `bridgeTokensPublic`: the SDK's one-liner generates
 * the claim secret INSIDE the call and returns it only after the L1 deposit has
 * mined. In that window the secret exists nowhere but process memory, and a
 * crash destroys it — and with it the entire deposit, because fee juice whose
 * claim preimage is lost cannot be redeemed by anyone. So the deposit is
 * assembled here from the same SDK pieces in the one safe order: generate the
 * secret, fsync it to the hardened journal, and only then touch L1. Everything
 * after the deposit (message key, leaf index) is recoverable from L1 logs; the
 * secret is the only thing that is not.
 *
 * The secret is NEVER printed and never accepted via argv; it lives in the
 * journal and in this function's return value (process memory), which
 * claimFeeJuice can consume directly.
 */
import type { AztecNode } from '@aztec/stdlib/interfaces/client';
import { type ConfirmAction, confirmAndRevalidate, createActionPlan } from './action-plan.js';
import { appendJournalRecord, BRIDGE_JOURNAL_FILE, type JournalHandle, withJournalLock } from './internal/journal.js';

/** The L1 client surface this module needs (an @aztec/ethereum extended client). */
export interface BridgeL1Client {
  account: { address: string };
  simulateContract(args: object): Promise<unknown>;
  estimateContractGas(args: object): Promise<bigint>;
  writeContract(args: object): Promise<`0x${string}`>;
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    status: string;
    logs: unknown[];
  }>;
}

export interface BridgeDeps {
  node: AztecNode;
  l1Client: BridgeL1Client;
  journal: JournalHandle;
  confirm: ConfirmAction;
  onProgress?: (msg: string) => void;
}

export interface BridgeRequest {
  /** L2 recipient (the paymaster, or a deployer account). */
  to: string;
  amountWei: bigint;
  /** Gas-estimate buffer in percent (>=100). Default 100 (2x). */
  gasLimitBufferPercent?: number;
}

export interface BridgeResult {
  l1TxHash: string;
  messageHash: string;
  messageLeafIndex: bigint;
  amountWei: bigint;
  /** Redeems the deposit. Keep OUT of argv/stdout; the journal holds the durable copy. */
  claimSecret: string;
}

export async function bridgeFeeJuice(deps: BridgeDeps, request: BridgeRequest): Promise<BridgeResult> {
  // Snapshot every execution input BEFORE validating or confirming. `request`
  // is caller-owned and mutable; a confirmation callback that mutates it after
  // validation would otherwise redirect or resize the deposit relative to what
  // the human approved (post-impl audit finding #1). Only the snapshot is used
  // from here on.
  const to = request.to;
  const amountWei = request.amountWei;
  const gasLimitBufferPercent = request.gasLimitBufferPercent;

  if (!/^0x[0-9a-fA-F]{64}$/.test(to)) {
    throw new Error(`recipient is not a 32-byte Aztec address: ${to}`);
  }
  // A zero recipient would burn the deposit outright: the claim would be
  // payable to nobody, and there is no refund path.
  if (/^0x0+$/.test(to)) {
    throw new Error('recipient is the zero address; the deposit would be lost');
  }
  // An Aztec address is a BN254 field element. The L1 portal accepts any
  // bytes32, but a value at/above the modulus can never equal a real address,
  // so the claim preimage can never match — the deposit is destroyed exactly
  // like the zero-address case. (Same guard the config layer applies to
  // adminAddress; review finding #1.)
  const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  if (BigInt(to) >= FIELD_MODULUS) {
    throw new Error(
      `recipient ${to} is not a valid field element — no Aztec address can ever claim it; the deposit would be lost`,
    );
  }
  if (amountWei <= 0n) throw new Error('amountWei must be positive');
  // The buffer controls the L1 gas limit — an execution-affecting input, so
  // it is validated AND appears in the confirmed plan (round-2 finding 6).
  // Range-bounded, not just finite: Number.MAX_VALUE is finite but the
  // basis-point scaling would overflow to Infinity and the BigInt conversion
  // would throw only AFTER the secret is journaled and the L1 approval is
  // mined (round-3 finding 5). 10000% (a 100x buffer) is already absurd.
  if (
    gasLimitBufferPercent !== undefined &&
    (!Number.isFinite(gasLimitBufferPercent) || gasLimitBufferPercent < 0 || gasLimitBufferPercent > 10_000)
  ) {
    throw new Error(`gasLimitBufferPercent must be a number in [0, 10000], got ${gasLimitBufferPercent}`);
  }

  // (Snapshotted after validation — the validators above must run before any
  // dep is touched — but before the confirm callback can observe or race it.)
  const from = deps.l1Client.account.address;

  const info = await deps.node.getNodeInfo();
  const portalAddress = info.l1ContractAddresses.feeJuicePortalAddress;
  const tokenAddress = info.l1ContractAddresses.feeJuiceAddress;
  if (portalAddress.isZero() || tokenAddress.isZero()) {
    throw new Error('Fee juice portal or token is not deployed on this L1');
  }
  const portalHex = portalAddress.toString() as `0x${string}`;

  const plan = createActionPlan('bridge-fee-juice', {
    l1ChainId: info.l1ChainId,
    from: from,
    to: to,
    amountWei: amountWei.toString(),
    portal: portalHex,
    gasLimitBufferPercent: Math.max(gasLimitBufferPercent ?? 100, 100),
    irreversible: true,
  });
  await confirmAndRevalidate(plan, deps.confirm, async () => {
    // Hostile-capable node discipline: re-read the portal immediately before
    // money moves; a different answer means the plan was built on sand.
    const again = await deps.node.getNodeInfo();
    return again.l1ContractAddresses.feeJuicePortalAddress.toString() === portalHex &&
      again.l1ChainId === info.l1ChainId
      ? undefined
      : 'portal address or chain id changed between reads';
  });

  const [{ L1FeeJuicePortalManager, generateClaimSecret }, { FeeJuicePortalAbi }, { extractEvent }, { createLogger }] =
    await Promise.all([
      import('@aztec/aztec.js/ethereum'),
      import('@aztec/l1-artifacts/FeeJuicePortalAbi'),
      import('@aztec/ethereum/utils'),
      import('@aztec/foundation/log'),
    ]);
  const logger = createLogger('quota-paymaster:bridge');

  return await withJournalLock(deps.journal, async () => {
    // ---- The secret comes first, and reaches disk before anything else. ----
    const [claimSecret, claimSecretHash] = await generateClaimSecret();
    appendJournalRecord(deps.journal, BRIDGE_JOURNAL_FILE, {
      state: 'SECRET_GENERATED',
      at: new Date().toISOString(),
      planDigest: plan.digest,
      l1Chain: info.l1ChainId,
      from: from,
      to: to,
      amountWei: amountWei.toString(),
      claimSecret: claimSecret.toString(),
      claimSecretHash: claimSecretHash.toString(),
      note: 'If no DEPOSIT_CONFIRMED line follows, check L1 for a DepositToAztecPublic log carrying this secretHash — the key and index are recoverable from it, and this secret is what redeems it.',
    });
    deps.onProgress?.('claim secret journaled; touching L1');

    // Approval is a separate, reversible L1 write; the SDK's token manager
    // already knows the ERC20 quirks.
    const portal = await L1FeeJuicePortalManager.new(deps.node, deps.l1Client as never, logger);
    await portal.getTokenManager().approve(amountWei, portalHex, 'FeeJuice Portal');

    const args = [to, amountWei, claimSecretHash.toString()] as const;
    // Simulate first: a revert here costs nothing, whereas a reverted deposit
    // costs gas and tells us less.
    await deps.l1Client.simulateContract({
      address: portalHex,
      abi: FeeJuicePortalAbi,
      functionName: 'depositToAztecPublic',
      args,
    });

    // Pad the estimate, rounding the buffer UP in basis points — flooring a
    // fractional percentage hands back a SMALLER buffer than asked, surfacing
    // as exactly the out-of-gas revert the buffer exists to prevent.
    const percent = Math.max(gasLimitBufferPercent ?? 100, 100);
    const bufferBps = BigInt(Math.ceil(percent * 100));
    const gasEstimate = await deps.l1Client.estimateContractGas({
      address: portalHex,
      abi: FeeJuicePortalAbi,
      functionName: 'depositToAztecPublic',
      args,
      account: deps.l1Client.account,
    });
    const hash = await deps.l1Client.writeContract({
      address: portalHex,
      abi: FeeJuicePortalAbi,
      functionName: 'depositToAztecPublic',
      args,
      gas: gasEstimate + (gasEstimate * bufferBps + 9_999n) / 10_000n,
    });
    deps.onProgress?.(`L1 deposit tx ${hash}`);
    const receipt = await deps.l1Client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`L1 deposit reverted: ${hash}. The journaled secret is unused; nothing was bridged.`);
    }

    // key + index identify the L1->L2 message. Unlike the secret, these are
    // permanently readable from L1 logs, so losing them here is recoverable.
    type DepositLog = {
      args: { to: string; amount: bigint; secretHash: string; key: string; index: bigint };
    };
    const log = extractEvent(
      receipt.logs as never,
      portalHex,
      FeeJuicePortalAbi,
      'DepositToAztecPublic',
      (l: DepositLog) =>
        l.args.secretHash.toLowerCase() === claimSecretHash.toString().toLowerCase() &&
        l.args.amount === amountWei &&
        l.args.to.toLowerCase() === to.toLowerCase(),
      logger,
    ) as DepositLog;

    appendJournalRecord(deps.journal, BRIDGE_JOURNAL_FILE, {
      state: 'DEPOSIT_CONFIRMED',
      at: new Date().toISOString(),
      planDigest: plan.digest,
      l1TxHash: hash,
      to: to,
      amountWei: amountWei.toString(),
      claimSecret: claimSecret.toString(),
      claimSecretHash: claimSecretHash.toString(),
      messageHash: log.args.key,
      messageLeafIndex: log.args.index.toString(),
    });

    return {
      l1TxHash: hash,
      messageHash: log.args.key,
      messageLeafIndex: log.args.index,
      amountWei: amountWei,
      claimSecret: claimSecret.toString(),
    };
  });
}
