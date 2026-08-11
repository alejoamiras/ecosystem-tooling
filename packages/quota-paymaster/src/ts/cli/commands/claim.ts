/** `claim` — redeem a bridged deposit. The secret comes from the journal. */
import { createInterface } from 'node:readline/promises';
import { claimFeeJuice, findClaimInJournal } from '../../operator/claim.js';
import { formatFeeJuiceWei } from '../../operator/internal/format.js';
import { closeJournalDir, openJournalDir } from '../../operator/internal/journal.js';
import { makeConfirm } from '../internal/confirm.js';
import { withContext } from '../internal/context.js';
import type { FlagSchema, ParsedFlags } from '../internal/flags.js';

export const schema: FlagSchema = {
  for: { type: 'string' },
  'config-module': { type: 'string' },
  'message-hash': { type: 'string' },
  'journal-dir': { type: 'string' },
  'secret-stdin': { type: 'boolean' },
  'amount-wei': { type: 'string' },
  'leaf-index': { type: 'string' },
  'allow-retry-after-unknown': { type: 'boolean' },
  yes: { type: 'boolean' },
};

export const usage =
  'claim --for 0x… --config-module <path> [--message-hash 0x…] [--journal-dir <path>]\n' +
  '      [--secret-stdin --amount-wei N --leaf-index N] [--allow-retry-after-unknown] [--yes]\n' +
  '  Default reads the hardened journal. A secret is NEVER accepted on argv;\n' +
  '  --secret-stdin reads ONLY the secret from stdin.\n' +
  '  --allow-retry-after-unknown proceeds despite a prior attempt with no recorded\n' +
  '  outcome — verify on-chain first, it may have landed.';

export async function run(flags: ParsedFlags): Promise<void> {
  const recipient = flags.require('for');

  await withContext(flags, async (ctx) => {
    const journal = openJournalDir(flags.get('journal-dir') ?? process.env.QUOTA_JOURNAL_DIR);
    try {
      const claim = flags.has('secret-stdin')
        ? {
            recipient,
            amountWei: BigInt(flags.require('amount-wei')),
            messageLeafIndex: BigInt(flags.require('leaf-index')),
            claimSecret: (await createInterface({ input: process.stdin }).question('claim secret: ')).trim(),
          }
        : findClaimInJournal(journal, {
            recipient,
            messageHash: flags.get('message-hash'),
            allowRetryAfterUnknownOutcome: flags.has('allow-retry-after-unknown'),
          });
      const { balanceBeforeWei, balanceAfterWei } = await claimFeeJuice(
        { node: ctx.node, wallet: ctx.wallet, from: ctx.from, confirm: makeConfirm(flags), journal },
        claim,
        ctx.sendOptions ?? {},
      );
      console.log(`\nClaimed. Balance ${formatFeeJuiceWei(balanceBeforeWei)} -> ${formatFeeJuiceWei(balanceAfterWei)}`);
    } finally {
      closeJournalDir(journal);
    }
  });
}
