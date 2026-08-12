/** `claim` — redeem a bridged deposit. The secret comes from the journal. */
import { MAX_FEE_JUICE_AMOUNT_WEI } from '../../operator/bridge.js';
import { claimFeeJuice, findClaimInJournal, MAX_L1_TO_L2_LEAF_INDEX } from '../../operator/claim.js';
import { formatFeeJuiceWei } from '../../operator/internal/format.js';
import { closeJournalDir, openJournalDir } from '../../operator/internal/journal.js';
import { makeConfirm } from '../internal/confirm.js';
import { withContext } from '../internal/context.js';
import {
  CliUsageError,
  type FlagSchema,
  journalDirFromEnv,
  type ParsedFlags,
  requireAddressFlag,
} from '../internal/flags.js';

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

const TTY_REFUSAL =
  '--secret-stdin refuses an interactive terminal (the secret would be echoed to the screen). ' +
  'Pipe it instead: printf %s "$SECRET" | ... --secret-stdin';

/** Malformed numbers are usage refusals (nothing happened), never failures. */
function parseBigint(raw: string, flag: string): bigint {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    throw new CliUsageError(`--${flag} must be an integer (got "${raw}")`);
  }
  // A negative amount or leaf index cannot describe a real deposit; refusing
  // here avoids confirming a claim that can only fail.
  if (value < 0n) throw new CliUsageError(`--${flag} must not be negative`);
  if (flag === 'amount-wei') {
    if (value === 0n) throw new CliUsageError('--amount-wei must be greater than zero');
    // The claim's amount is a u128 and the L1->L2 tree has 2^36 leaves, so a
    // larger value names a claim that cannot exist on either side.
    if (value > MAX_FEE_JUICE_AMOUNT_WEI) {
      throw new CliUsageError('--amount-wei exceeds the u128 a fee-juice claim accepts');
    }
  }
  if (flag === 'leaf-index' && value > MAX_L1_TO_L2_LEAF_INDEX) {
    throw new CliUsageError('--leaf-index is past the last leaf of the L1->L2 message tree');
  }
  return value;
}

/**
 * Reads ONLY the secret from stdin, and refuses an interactive terminal: at a
 * TTY the typed secret is echoed to the screen and into scrollback, which is
 * the same exposure --secret-on-argv exists to avoid. Pipe it instead:
 *   printf %s "$SECRET" | quota-paymaster claim ... --secret-stdin
 */
async function readSecretFromStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new CliUsageError(TTY_REFUSAL);
  // Read the STREAM, not a line: readline's question() never resolves on EOF
  // without a trailing newline, so `printf %s "$SECRET" | ...` — the exact
  // invocation this command's own help prescribes — left the promise pending,
  // the event loop drained, and the process exited 0 having done nothing,
  // which for a claim reads as success (round-12).
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const secret = Buffer.concat(chunks).toString('utf8').trim();
  if (!secret) {
    throw new CliUsageError('--secret-stdin was given nothing on stdin (the pipe was empty)');
  }
  return secret;
}

export async function run(flags: ParsedFlags): Promise<void> {
  const recipient = requireAddressFlag(flags, 'for');
  // Parse and range-check BEFORE withContext: a refusal must not have executed
  // the operator's config module, which is arbitrary code (round-6 finding 1;
  // same hoisting the other commands already do).
  // Flags that only mean something in manual mode are REFUSED outside it,
  // rather than parsed and dropped: `claim --for X --amount-wei N --leaf-index
  // M` claimed whatever the journal selected instead, with a digest identical
  // to the run that named nothing — so the confirmed plan looked right while
  // claiming a different deposit (round-15). Same shape as `policy --show`
  // silently ignoring edit flags.
  if (!flags.has('secret-stdin')) {
    const manualOnly = ['amount-wei', 'leaf-index', 'allow-retry-after-unknown'].filter((f) => flags.has(f));
    if (manualOnly.length > 0) {
      throw new CliUsageError(
        `${manualOnly.map((f) => `--${f}`).join(', ')} only applies to a manual claim; add --secret-stdin and pipe ` +
          `the secret, or drop them to claim the deposit recorded in the journal.`,
      );
    }
  }
  const manualAmounts = flags.has('secret-stdin')
    ? {
        amountWei: parseBigint(flags.require('amount-wei'), 'amount-wei'),
        messageLeafIndex: parseBigint(flags.require('leaf-index'), 'leaf-index'),
      }
    : undefined;
  // The TTY refusal belongs up here with the other refusals: at a terminal
  // this command can never proceed, so running the operator's config module
  // first is pure cost (round-7 finding 3).
  if (manualAmounts && process.stdin.isTTY) throw new CliUsageError(TTY_REFUSAL);
  // Read the pipe here too: an empty pipe is a usage refusal, and refusing it
  // after withContext means the operator's config module has already run, the
  // node has been contacted and a wallet store created for nothing (round-13).
  // A manual claim MUST name its deposit: every journal write is gated on the
  // message hash, so without one a successful claim recorded nothing and the
  // next `claim --for` re-targeted the deposit it had just redeemed. A
  // malformed one is worse — it records success under a key that is not the
  // deposit, leaving the real one selectable again (round-15).
  const manualMessageHash = manualAmounts ? requireAddressFlag(flags, 'message-hash') : undefined;
  const manualSecret = manualAmounts ? await readSecretFromStdin() : undefined;

  await withContext(flags, async (ctx) => {
    const journal = openJournalDir(flags.get('journal-dir') ?? journalDirFromEnv());
    try {
      const claim = manualAmounts
        ? {
            recipient,
            ...manualAmounts,
            messageHash: manualMessageHash,
            claimSecret: manualSecret as string,
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
