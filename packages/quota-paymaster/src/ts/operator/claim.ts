/**
 * Redeems a bridged fee-juice claim on behalf of a recipient.
 *
 * Why this exists separately from bridging: the paymaster is a CONTRACT, and a
 * contract cannot send the transaction that would claim its own juice. Anyone
 * may claim on a recipient's behalf — the claim secret is the authorisation —
 * so the operator's account does it, paying the gas itself.
 *
 * The secret arrives from the journal (by message hash, or the latest
 * unclaimed deposit for a recipient) or as an in-memory value handed over by
 * bridgeFeeJuice — NEVER via argv, which leaks through shell history and
 * process listings.
 */
import { createHash } from 'node:crypto';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Wallet } from '@aztec/aztec.js/wallet';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';
import { type ConfirmAction, confirmAndRevalidate, createActionPlan, snapshotOptions } from './action-plan.js';
import { MAX_FEE_JUICE_AMOUNT_WEI } from './bridge.js';
import {
  appendJournalRecord,
  BRIDGE_JOURNAL_FILE,
  type JournalHandle,
  readJournalRecords,
  withJournalLock,
} from './internal/journal.js';

/** The L1->L2 message tree holds 2^L1_TO_L2_MSG_TREE_HEIGHT (36) leaves. */
export const MAX_L1_TO_L2_LEAF_INDEX = (1n << 36n) - 1n;

export interface ClaimDeps {
  node: AztecNode;
  wallet: Wallet;
  /** The account that pays gas for the claim. */
  from: AztecAddress;
  confirm: ConfirmAction;
  /** When given, a CLAIMED record is appended after success so
   * findClaimInJournal's "latest unclaimed" stays truthful. */
  journal?: JournalHandle;
}

export interface ClaimDetails {
  recipient: string;
  amountWei: bigint;
  claimSecret: string;
  messageLeafIndex: bigint;
  /** Identifies the deposit for CLAIMED bookkeeping (set by findClaimInJournal). */
  messageHash?: string;
}

/**
 * Finds a DEPOSIT_CONFIRMED journal record to claim: by message hash when
 * given, else the LATEST record for the recipient. Returns the claim details —
 * secret included, so treat the return value like the secret it carries.
 */
export function findClaimInJournal(
  journal: JournalHandle,
  query: {
    recipient: string;
    messageHash?: string;
    /**
     * Proceed even though a prior attempt for the selected deposit ended with
     * an UNKNOWN outcome (its wait timed out after broadcast — it may still
     * checkpoint). Verify on-chain first (recipient balance / tx receipt); a
     * retry against an already-redeemed deposit fails and burns gas.
     */
    allowRetryAfterUnknownOutcome?: boolean;
  },
): ClaimDetails {
  const { records, tornLines } = readJournalRecords(journal, BRIDGE_JOURNAL_FILE);
  if (tornLines > 0) {
    throw new Error(
      `journal has ${tornLines} torn line(s) — a crash mid-append. Inspect it manually before ` +
        `claiming; a truncated record may hide the deposit you are looking for.`,
    );
  }
  // "Latest UNCLAIMED": claimFeeJuice appends a CLAIMED record, so already-
  // redeemed deposits are excluded here (review finding #10 — without this,
  // "claim the other deposit" re-targeted the newest, already-claimed one).
  const claimed = new Set(records.filter((r) => r.state === 'CLAIMED').map((r) => String(r.messageHash).toLowerCase()));
  // An EXPLICIT message hash must not bypass the claimed-set either: retrying
  // a claim that already succeeded burns gas on a doomed transaction and can
  // mask which deposit the operator actually meant (post-impl audit finding #8).
  if (query.messageHash !== undefined && claimed.has(query.messageHash.toLowerCase())) {
    throw new Error(
      `deposit ${query.messageHash} is already recorded as CLAIMED in the journal; ` +
        `refusing to build a claim for it. Inspect the journal if you believe this is wrong.`,
    );
  }
  const matches = records.filter(
    (r) =>
      r.state === 'DEPOSIT_CONFIRMED' &&
      String(r.to).toLowerCase() === query.recipient.toLowerCase() &&
      (query.messageHash === undefined
        ? !claimed.has(String(r.messageHash).toLowerCase())
        : String(r.messageHash).toLowerCase() === query.messageHash.toLowerCase()),
  );
  const record = matches.at(-1);
  // Attempt-limbo guard (round-4 finding 3): a CLAIM_OUTCOME_UNKNOWN without
  // a later CLAIMED means a prior attempt's wait timed out AFTER broadcast —
  // the claim may still land. Building a retry blindly would target an
  // already-redeemed deposit.
  if (record && !query.allowRetryAfterUnknownOutcome) {
    const hash = String(record.messageHash).toLowerCase();
    const lastMarker = records
      .filter(
        (r) =>
          (r.state === 'CLAIM_SUBMITTING' ||
            r.state === 'CLAIM_OUTCOME_UNKNOWN' ||
            r.state === 'CLAIM_FAILED' ||
            r.state === 'CLAIMED') &&
          String(r.messageHash).toLowerCase() === hash,
      )
      .at(-1);
    // A dangling CLAIM_SUBMITTING (crash mid-send) is the same ambiguity as
    // an explicit UNKNOWN outcome: the transaction may have broadcast.
    // CLAIMED and CLAIM_FAILED are RESOLVED outcomes — no limbo.
    if (lastMarker && lastMarker.state !== 'CLAIMED' && lastMarker.state !== 'CLAIM_FAILED') {
      throw new Error(
        `a prior claim attempt for deposit ${record.messageHash} has no recorded outcome ` +
          `(${String(lastMarker.error ?? 'crashed or timed out mid-send')}) — it may still land. Verify on-chain ` +
          `(recipient balance / tx receipt), then pass allowRetryAfterUnknownOutcome to proceed deliberately.`,
      );
    }
  }
  if (!record) {
    throw new Error(
      `no unclaimed DEPOSIT_CONFIRMED journal record for ${query.recipient}` +
        (query.messageHash ? ` with message ${query.messageHash}` : '') +
        `. If the deposit exists on L1, recover key/index from its DepositToAztecPublic log ` +
        `and look for the matching SECRET_GENERATED record.`,
    );
  }
  return {
    recipient: String(record.to),
    amountWei: BigInt(String(record.amountWei)),
    claimSecret: String(record.claimSecret),
    messageLeafIndex: BigInt(String(record.messageLeafIndex)),
    messageHash: String(record.messageHash),
  };
}

export async function claimFeeJuice(
  deps: ClaimDeps,
  claim: ClaimDetails,
  sendOptions: Record<string, unknown> = {},
): Promise<{ balanceBeforeWei: bigint; balanceAfterWei: bigint }> {
  // Snapshot the caller-owned claim BEFORE confirming; a confirmation callback
  // mutating it after the digest was shown would redirect the claim relative
  // to what the human approved (post-impl audit finding #1).
  const recipientStr = claim.recipient;
  const amountWei = claim.amountWei;
  const claimSecret = claim.claimSecret;
  const messageLeafIndex = claim.messageLeafIndex;
  const messageHash = claim.messageHash;
  const from = deps.from;
  // Snapshot the options too, and take control of `wait`: CLAIMED bookkeeping
  // below requires a receipt at CHECKPOINTED-or-better finality, so
  // `wait: NO_WAIT` (resolves at submission), `wait: {dontThrowOnRevert}`
  // (resolves on a reverted receipt), and `waitForStatus: PROPOSED` (a status
  // a reorg can still evict — journaling CLAIMED there strands a claimable
  // deposit behind the claimed-set filter) are all overridden. A caller may
  // still request STRONGER finality (PROVEN/FINALIZED) or tune
  // timeout/interval (post-impl audit rounds 2-3, finding 3/2).
  const { wait: callerWait, ...sendOpts } = snapshotOptions(sendOptions);

  // Bounds the on-chain types impose: the claim amount is a u128 and the
  // L1->L2 message tree has 2^36 leaves (L1_TO_L2_MSG_TREE_HEIGHT = 36), so a
  // value above either describes a claim that cannot exist. Refusing here
  // keeps it out of the plan a human is asked to approve (round-5 finding 2).
  if (amountWei > MAX_FEE_JUICE_AMOUNT_WEI) {
    throw new Error(`amountWei ${amountWei} exceeds the u128 the fee-juice claim accepts`);
  }
  if (messageLeafIndex > MAX_L1_TO_L2_LEAF_INDEX) {
    throw new Error(`messageLeafIndex ${messageLeafIndex} is past the last leaf of the L1->L2 message tree`);
  }

  const recipient = AztecAddress.fromStringUnsafe(recipientStr);
  const { getFeeJuiceBalance } = await import('@aztec/aztec.js/utils');
  const [before, info] = await Promise.all([
    getFeeJuiceBalance(recipient, deps.node).then((b) => BigInt(b ?? 0n)),
    deps.node.getNodeInfo(),
  ]);

  const plan = createActionPlan('claim-fee-juice', {
    l1ChainId: info.l1ChainId,
    rollupVersion: info.rollupVersion,
    recipient: recipientStr,
    amountWei: amountWei.toString(),
    messageLeafIndex: messageLeafIndex.toString(),
    paidForBy: from.toString(),
    // The digest COVERS the secret without exposing it in the plan a UI shows:
    // a hash commits to the exact preimage, so a swapped secret changes the
    // digest, where a bare "present" boolean would not (finding #1).
    claimSecretSha256: createHash('sha256').update(claimSecret).digest('hex'),
  });
  await confirmAndRevalidate(plan, deps.confirm, async () => {
    const again = await deps.node.getNodeInfo();
    return again.l1ChainId === info.l1ChainId && again.rollupVersion === info.rollupVersion
      ? undefined
      : 'chain identity changed between reads';
  });

  const { FeeJuiceContract } = await import('@aztec/aztec.js/protocol');
  const { Fr } = await import('@aztec/aztec.js/fields');
  const { TxStatus } = await import('@aztec/stdlib/tx');
  // Finality floor: honor the caller's timeout/interval and any REQUEST FOR
  // MORE finality, but never less than CHECKPOINTED, and never revert-tolerant.
  const FINALITY_ORDER = [TxStatus.PROPOSED, TxStatus.CHECKPOINTED, TxStatus.PROVEN, TxStatus.FINALIZED];
  const callerWaitObj = callerWait && typeof callerWait === 'object' ? (callerWait as Record<string, unknown>) : {};
  const requestedStatus = callerWaitObj.waitForStatus as (typeof FINALITY_ORDER)[number] | undefined;
  const waitForStatus =
    requestedStatus !== undefined &&
    FINALITY_ORDER.indexOf(requestedStatus) > FINALITY_ORDER.indexOf(TxStatus.CHECKPOINTED)
      ? requestedStatus
      : TxStatus.CHECKPOINTED;
  // Durable attempt marker BEFORE the send (round-4 finding 3): if the wait
  // times out AFTER broadcast, the claim may still checkpoint later with
  // nothing journaled — a retry would then burn gas on an already-redeemed
  // deposit. CLAIM_SUBMITTING (resolved by a later CLAIMED, or left dangling
  // by a crash/timeout) is what lets findClaimInJournal warn instead.
  if (deps.journal && messageHash) {
    await withJournalLock(deps.journal, () => {
      appendJournalRecord(deps.journal as JournalHandle, BRIDGE_JOURNAL_FILE, {
        state: 'CLAIM_SUBMITTING',
        at: new Date().toISOString(),
        to: recipientStr,
        amountWei: amountWei.toString(),
        messageHash,
      });
    });
  }

  // sendOpts spreads FIRST: the confirmed payer is bound and cannot be
  // overridden by an unconfirmed option (finding #1).
  let receipt: {
    isMined(): boolean;
    hasExecutionSucceeded(): boolean;
    txHash: { toString(): string };
    status: string;
    error?: string;
  };
  try {
    ({ receipt } = await FeeJuiceContract.at(deps.wallet)
      .methods.claim(recipient, amountWei, Fr.fromString(claimSecret), messageLeafIndex)
      .send({ ...sendOpts, from, wait: { ...callerWaitObj, waitForStatus, dontThrowOnRevert: false } }));
  } catch (err) {
    // The failure may be POST-broadcast (a wait timeout): record the unknown
    // outcome durably so the ambiguity survives a process exit.
    if (deps.journal && messageHash) {
      await withJournalLock(deps.journal, () => {
        appendJournalRecord(deps.journal as JournalHandle, BRIDGE_JOURNAL_FILE, {
          state: 'CLAIM_OUTCOME_UNKNOWN',
          at: new Date().toISOString(),
          to: recipientStr,
          messageHash,
          error: String((err as { message?: string })?.message ?? err),
        });
      });
    }
    throw err;
  }
  if (!receipt.isMined() || !receipt.hasExecutionSucceeded()) {
    // Only a MINED revert is a definitive, retry-safe failure. An UNMINED
    // receipt handed back by a nonstandard wallet (the standard wait helper
    // throws before returning one) proves nothing about the transaction's
    // fate — treat it as limbo, not resolution (round-6 observation 1).
    // NOTE: with the standard wallet this whole branch is rarely reached
    // (reverts/drops throw from the wait and land in the catch above as
    // CLAIM_OUTCOME_UNKNOWN — fail-safe, merely conservative).
    const definitiveMinedRevert = receipt.isMined() && !receipt.hasExecutionSucceeded();
    if (deps.journal && messageHash) {
      await withJournalLock(deps.journal, () => {
        appendJournalRecord(deps.journal as JournalHandle, BRIDGE_JOURNAL_FILE, {
          state: definitiveMinedRevert ? 'CLAIM_FAILED' : 'CLAIM_OUTCOME_UNKNOWN',
          at: new Date().toISOString(),
          to: recipientStr,
          messageHash,
          error: `status ${receipt.status}${receipt.error ? `: ${receipt.error}` : ''}`,
        });
      });
    }
    throw new Error(
      `claim transaction ${receipt.txHash} did not execute successfully ` +
        `(status ${receipt.status}${receipt.error ? `: ${receipt.error}` : ''}); ` +
        (definitiveMinedRevert
          ? 'journaled as CLAIM_FAILED — the deposit remains claimable'
          : 'journaled as CLAIM_OUTCOME_UNKNOWN — verify on-chain before retrying'),
    );
  }

  // Journal CLAIMED immediately after the MINED SUCCESS — BEFORE the
  // balance-after read. A transient RPC failure on that read must not leave a
  // redeemed deposit recorded as unclaimed (finding #8).
  if (deps.journal && messageHash) {
    await withJournalLock(deps.journal, () => {
      appendJournalRecord(deps.journal as JournalHandle, BRIDGE_JOURNAL_FILE, {
        state: 'CLAIMED',
        at: new Date().toISOString(),
        to: recipientStr,
        amountWei: amountWei.toString(),
        messageHash,
      });
    });
  }

  const after = BigInt((await getFeeJuiceBalance(recipient, deps.node)) ?? 0n);
  return { balanceBeforeWei: before, balanceAfterWei: after };
}
