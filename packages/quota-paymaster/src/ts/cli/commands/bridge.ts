/** `bridge` — L1 deposit into Aztec fee juice. IRREVERSIBLE. */
import { bridgeFeeJuice } from '../../operator/bridge.js';
import { OperatorConfigError } from '../../operator/config-module.js';
import { formatFeeJuiceWei } from '../../operator/internal/format.js';
import { closeJournalDir, openJournalDir } from '../../operator/internal/journal.js';
import { makeConfirm } from '../internal/confirm.js';
import { withContext } from '../internal/context.js';
import { CliUsageError, type FlagSchema, type ParsedFlags } from '../internal/flags.js';

export const schema: FlagSchema = {
  to: { type: 'string' },
  'amount-wei': { type: 'string' },
  amount: { type: 'string' },
  'config-module': { type: 'string' },
  'journal-dir': { type: 'string' },
  'gas-limit-buffer-percent': { type: 'string' },
  yes: { type: 'boolean' },
};

export const usage =
  'bridge --to 0x… (--amount-wei N | --amount <whole AZTEC>) --config-module <path> [--journal-dir <path>] [--yes]\n' +
  '  IRREVERSIBLE: fee juice cannot be withdrawn or moved once it lands.\n' +
  '  The claim secret is fsync-journaled BEFORE L1 is touched, and never printed.\n' +
  "  Needs L1 access in the config's context (L1_RPC_URL + L1_PRIVATE_KEY for schnorrAccountFromEnv).";

const WEI_PER_AZTEC = 10n ** 18n;

export async function run(flags: ParsedFlags): Promise<void> {
  const to = flags.require('to');
  const amountWeiFlag = flags.get('amount-wei');
  const amountFlag = flags.get('amount');
  if ((amountWeiFlag === undefined) === (amountFlag === undefined)) {
    throw new CliUsageError('pass exactly one of --amount-wei <N> or --amount <whole AZTEC>');
  }
  if (amountFlag !== undefined && !/^\d+$/.test(amountFlag)) {
    throw new CliUsageError('--amount takes whole AZTEC units (integer); use --amount-wei for precision');
  }
  let amountWei: bigint;
  try {
    amountWei = amountWeiFlag !== undefined ? BigInt(amountWeiFlag) : BigInt(amountFlag as string) * WEI_PER_AZTEC;
  } catch {
    // A malformed amount is a refusal: nothing was sent, so exit 2 not 1.
    throw new CliUsageError(`--amount-wei must be an integer (got "${amountWeiFlag}")`);
  }
  const bufferPercent = flags.get('gas-limit-buffer-percent');
  if (bufferPercent !== undefined && !/^\d+(\.\d+)?$/.test(bufferPercent)) {
    throw new CliUsageError('--gas-limit-buffer-percent must be a non-negative number');
  }

  await withContext(flags, async (ctx) => {
    if (!ctx.l1) {
      throw new OperatorConfigError(
        'shape-invalid',
        'bridge needs L1 access, but the config context has no `l1.client`. With schnorrAccountFromEnv, ' +
          'set L1_RPC_URL and L1_PRIVATE_KEY in the environment (never on argv).',
      );
    }
    const journal = openJournalDir(flags.get('journal-dir') ?? process.env.QUOTA_JOURNAL_DIR);
    try {
      const result = await bridgeFeeJuice(
        {
          node: ctx.node,
          l1Client: ctx.l1.client,
          journal,
          confirm: makeConfirm(flags),
          onProgress: (m) => console.log(`  ${m}`),
        },
        { to, amountWei, gasLimitBufferPercent: bufferPercent ? Number(bufferPercent) : undefined },
      );
      console.log(`\nBridged ${formatFeeJuiceWei(result.amountWei)} to ${to}.`);
      console.log(`  message hash ${result.messageHash}`);
      console.log(`  leaf index   ${result.messageLeafIndex}`);
      console.log('  The claim secret is JOURNALED (not printed). Redeem with: claim --for <recipient>.');
    } finally {
      closeJournalDir(journal);
    }
  });
}
