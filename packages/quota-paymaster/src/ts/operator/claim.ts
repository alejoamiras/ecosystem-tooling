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
import { type ConfirmAction, confirmAndRevalidate, createActionPlan } from './action-plan.js';
import {
  appendJournalRecord,
  BRIDGE_JOURNAL_FILE,
  type JournalHandle,
  readJournalRecords,
  withJournalLock,
} from './internal/journal.js';

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
  query: { recipient: string; messageHash?: string },
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
  // Snapshot the options too, and strip any caller-supplied `wait`: CLAIMED
  // bookkeeping below requires a MINED SUCCESS receipt, so `wait: NO_WAIT`
  // (resolves at submission) or `wait: {dontThrowOnRevert}` (resolves on a
  // reverted receipt) would let a dropped/reverted claim be journaled as
  // redeemed (post-impl audit round 2, finding 3).
  const { wait: _callerWait, ...sendOpts } = { ...sendOptions };

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
  // sendOpts spreads FIRST: the confirmed payer is bound and cannot be
  // overridden by an unconfirmed option (finding #1); default wait semantics
  // (mine + throw on revert) are enforced by the wait-stripping above.
  const { receipt } = await FeeJuiceContract.at(deps.wallet)
    .methods.claim(recipient, amountWei, Fr.fromString(claimSecret), messageLeafIndex)
    .send({ ...sendOpts, from });
  if (!receipt.isMined() || !receipt.hasExecutionSucceeded()) {
    throw new Error(
      `claim transaction ${receipt.txHash} did not execute successfully ` +
        `(status ${receipt.status}${receipt.error ? `: ${receipt.error}` : ''}); nothing journaled`,
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
