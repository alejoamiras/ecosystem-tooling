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
  const recipient = AztecAddress.fromStringUnsafe(claim.recipient);
  const { getFeeJuiceBalance } = await import('@aztec/aztec.js/utils');
  const before = BigInt((await getFeeJuiceBalance(recipient, deps.node)) ?? 0n);

  const plan = createActionPlan('claim-fee-juice', {
    recipient: claim.recipient,
    amountWei: claim.amountWei.toString(),
    messageLeafIndex: claim.messageLeafIndex.toString(),
    paidForBy: deps.from.toString(),
    // The digest covers the secret WITHOUT exposing it in the plan a UI shows.
    claimSecretPresent: claim.claimSecret.length > 0,
  });
  await confirmAndRevalidate(plan, deps.confirm, async () => undefined);

  const { FeeJuiceContract } = await import('@aztec/aztec.js/protocol');
  const { Fr } = await import('@aztec/aztec.js/fields');
  await FeeJuiceContract.at(deps.wallet)
    .methods.claim(recipient, claim.amountWei, Fr.fromString(claim.claimSecret), claim.messageLeafIndex)
    .send({ from: deps.from, ...sendOptions });

  const after = BigInt((await getFeeJuiceBalance(recipient, deps.node)) ?? 0n);

  if (deps.journal && claim.messageHash) {
    await withJournalLock(deps.journal, () => {
      appendJournalRecord(deps.journal as JournalHandle, BRIDGE_JOURNAL_FILE, {
        state: 'CLAIMED',
        at: new Date().toISOString(),
        to: claim.recipient,
        amountWei: claim.amountWei.toString(),
        messageHash: claim.messageHash as string,
      });
    });
  }

  return { balanceBeforeWei: before, balanceAfterWei: after };
}
