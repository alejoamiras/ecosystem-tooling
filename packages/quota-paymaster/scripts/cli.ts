/**
 * Thin, REPO-LOCAL operator CLI over the published DI library — deliberately
 * NOT shipped (no bin, not in the tarball). Environment resolution and
 * interactive confirmation live HERE; the library stays headless.
 *
 *   bun scripts/cli.ts deploy  --config <path> [--dry-run] [--yes]
 *   bun scripts/cli.ts policy  --fpc 0x… [--show] [--max-fee-wei N] [--max-uses N] [--max-users N] [--cancel] [--yes]
 *   bun scripts/cli.ts bridge  --to 0x… --amount-wei N [--yes]
 *   bun scripts/cli.ts claim   --for 0x… [--message-hash 0x…] [--yes]
 *   bun scripts/cli.ts measure --fpc 0x… --count N
 *
 * Env: NODE_URL (default http://localhost:8080), L1_RPC_URL (default
 * http://127.0.0.1:8545), L1_PRIVATE_KEY (bridge only), QUOTA_JOURNAL_DIR.
 *
 * SECRETS ARE NEVER ACCEPTED ON ARGV. `claim` reads the secret from the
 * hardened journal (or stdin via --secret-stdin); a --secret flag is REFUSED
 * loudly — argv leaks through shell history and process listings.
 *
 * Current wallet scope: LOCAL NETWORKS (the pre-registered test accounts).
 * Operating against a live network needs real key custody wiring — a
 * deliberate future step, not an accident waiting in an env var.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseQuotaFpcConfig, QuotaFpcConfigError } from '../src/ts/config/schema.js';
import { DARK_FOREST_REFERENCE_GAS_PROFILE, type GasProfile } from '../src/ts/gas-profile.js';
import type { ActionPlan } from '../src/ts/operator/action-plan.js';
import {
  bridgeFeeJuice,
  cancelPendingPolicyChange,
  claimFeeJuice,
  closeJournalDir,
  deployQuotaFpc,
  findClaimInJournal,
  formatFeeJuiceWei,
  openJournalDir,
  readPolicyState,
  schedulePolicyChange,
} from '../src/ts/operator/index.js';

const USAGE = `Usage: bun scripts/cli.ts <deploy|policy|bridge|claim|measure> [flags]
Run a subcommand with --help for its flags. Secrets are never accepted on argv.`;

type Flags = Map<string, string | true>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  if (flags.has('secret')) {
    throw new Error(
      'REFUSED: --secret puts a claim secret into shell history and process listings. ' +
        'Use the journal (default) or --secret-stdin.',
    );
  }
  return flags;
}

function requireString(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string') throw new Error(`--${name} <value> is required`);
  return value;
}

/** Interactive plan gate; --yes skips the prompt but still prints the plan. */
function makeConfirm(flags: Flags) {
  return async (plan: ActionPlan): Promise<boolean> => {
    console.log(`\nAction plan: ${plan.kind}`);
    for (const [key, value] of Object.entries(plan.details)) {
      console.log(`  ${key.padEnd(26)} ${value}`);
    }
    console.log(`  digest                     ${plan.digest}`);
    if (flags.has('yes')) return true;
    if (!process.stdin.isTTY) {
      console.error('\nRefusing: not a TTY and --yes was not passed.');
      return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('\nProceed? Type the first 6 digest chars to confirm: ');
      return answer.trim() === plan.digest.slice(0, 6);
    } finally {
      rl.close();
    }
  };
}

async function makeLocalContext(flags: Flags) {
  const nodeUrl = (flags.get('node-url') as string) ?? process.env.NODE_URL ?? 'http://localhost:8080';
  const { createAztecNodeClient, waitForNode } = await import('@aztec/aztec.js/node');
  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { registerInitialLocalNetworkAccountsInWallet } = await import('@aztec/wallets/testing');
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
  const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);
  if (accounts.length === 0) throw new Error('no pre-registered accounts on this network');
  return { node, wallet, from: accounts[0], nodeUrl };
}

function gasProfileFrom(flags: Flags): GasProfile {
  // Operators SHOULD pass their measured profile; the reference numbers are a
  // labeled default for local experimentation only.
  if (flags.has('gas-profile')) {
    return JSON.parse(readFileSync(String(flags.get('gas-profile')), 'utf8')) as GasProfile;
  }
  console.warn('  (using DARK_FOREST_REFERENCE_GAS_PROFILE — pass --gas-profile <json> with YOUR measured numbers)');
  return DARK_FOREST_REFERENCE_GAS_PROFILE;
}

async function cmdDeploy(flags: Flags): Promise<void> {
  if (flags.has('help')) {
    console.log('deploy --config <path> [--dry-run] [--yes] [--allow-unverified-account-class] [--node-url URL]');
    return;
  }
  const configPath = requireString(flags, 'config');
  let config: ReturnType<typeof parseQuotaFpcConfig>;
  try {
    config = parseQuotaFpcConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch (err) {
    if (err instanceof QuotaFpcConfigError) {
      console.error(`\nConfig rejected: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  if (flags.has('dry-run')) {
    console.log(`\nDry run: config "${config.name}" is valid, nothing was sent.`);
    console.log(`  admin ${config.adminAddress}; ${config.resolvedTargets.length} target(s).`);
    return;
  }
  const { wallet, from } = await makeLocalContext(flags);
  const contract = await deployQuotaFpc(
    { wallet: wallet as never, from, confirm: makeConfirm(flags), onWarn: (m) => console.warn(`  WARNING: ${m}`) },
    config,
    { allowUnverifiedAccountClasses: flags.has('allow-unverified-account-class') },
  );
  console.log(`\nDeployed. QUOTA_FPC_CONTRACT_ADDRESS=${contract.address.toString()}`);
  console.log('The paymaster holds no fee juice and sponsors nothing until funded. Fund LAST, in tranches.');
}

async function cmdPolicy(flags: Flags): Promise<void> {
  if (flags.has('help')) {
    console.log(
      'policy --fpc 0x… [--show] [--max-fee-wei N] [--max-uses N] [--max-users N] [--cancel]\n' +
        '       [--max-loss-wei N] [--gas-profile <json>] [--accept-below-floor] [--accept-above-max-loss] [--yes]',
    );
    return;
  }
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const fpcAddress = AztecAddress.fromStringUnsafe(requireString(flags, 'fpc'));
  const { node, wallet, from } = await makeLocalContext(flags);
  const gasProfile = gasProfileFrom(flags);
  const deps = { node, wallet: wallet as never, from, fpcAddress };

  const state = await readPolicyState(deps, gasProfile);
  console.log(`\nPaymaster ${fpcAddress.toString()}`);
  console.log(`  admin        ${state.admin}`);
  console.log(
    `  live policy  maxFee ${formatFeeJuiceWei(state.live.maxFeeWei)}, ${state.live.maxUses} tx/user/day, ${state.live.maxUsers} users/day`,
  );
  console.log(`  targets      ${state.live.allowedTargets.length}`);
  console.log(
    `  scheduled    rev ${state.scheduled.revision}${state.scheduled.pending ? ` PENDING (activates at chain t=${state.scheduled.activatesAt})` : ' (in force)'}`,
  );
  console.log(`  balance      ${formatFeeJuiceWei(state.balanceWei)}`);
  console.log(
    `  reserve      ${formatFeeJuiceWei(state.sequencerReserveWei)} (below this the sequencer admits NOTHING sponsored)`,
  );
  if (state.balanceWei < state.sequencerReserveWei) {
    console.log('  ** BALANCE BELOW RESERVE: this paymaster currently sponsors NOTHING. **');
  }
  if (flags.has('show')) return;

  const maxLossWei = BigInt(requireString(flags, 'max-loss-wei'));
  const guards = {
    maxLossWei,
    gasProfile,
    acceptCeilingBelowClientFloor: flags.has('accept-below-floor'),
    acceptWorstCaseAboveMaxLoss: flags.has('accept-above-max-loss'),
  };
  const confirm = makeConfirm(flags);
  if (flags.has('cancel')) {
    const { scheduledRevision, pendingActivatedFirst } = await cancelPendingPolicyChange({ ...deps, confirm }, guards);
    if (pendingActivatedFirst) {
      console.error(
        '\nWARNING: the pending change ACTIVATED before the cancel landed — it is LIVE NOW, and the ' +
          'captured previous values are scheduled to replace it in ~12h (a delayed restore, not a clean cancel). ' +
          'Review `policy --show` and decide whether to keep that restore.',
      );
    }
    console.log(`\nPending change replaced with the live values (revision ${scheduledRevision}).`);
    return;
  }
  const change = {
    maxFeeWei: flags.has('max-fee-wei') ? BigInt(String(flags.get('max-fee-wei'))) : undefined,
    maxUses: flags.has('max-uses') ? Number(flags.get('max-uses')) : undefined,
    maxUsers: flags.has('max-users') ? Number(flags.get('max-users')) : undefined,
  };
  const { scheduledRevision, pendingActivatedFirst } = await schedulePolicyChange({ ...deps, confirm }, change, guards);
  if (pendingActivatedFirst) {
    console.error(
      '\nWARNING: the previously-pending change ACTIVATED before this schedule landed — it is LIVE NOW; ' +
        'your confirmed values replace it in ~12h. Review `policy --show`.',
    );
  }
  console.log(`\nScheduled (revision ${scheduledRevision}). Takes effect in 12h; one pending slot.`);
}

async function cmdBridge(flags: Flags): Promise<void> {
  if (flags.has('help')) {
    console.log('bridge --to 0x… --amount-wei N [--yes] [--node-url URL] [--l1-rpc URL]');
    console.log('Requires L1_PRIVATE_KEY in the environment. IRREVERSIBLE.');
    return;
  }
  const to = requireString(flags, 'to');
  const amountWei = BigInt(requireString(flags, 'amount-wei'));
  const l1Key = process.env.L1_PRIVATE_KEY;
  if (!l1Key) throw new Error('L1_PRIVATE_KEY is required in the environment (never on argv)');
  const { node } = await makeLocalContext(flags);
  const info = await node.getNodeInfo();
  const l1Rpc = (flags.get('l1-rpc') as string) ?? process.env.L1_RPC_URL ?? 'http://127.0.0.1:8545';
  const { createEthereumChain } = await import('@aztec/ethereum/chain');
  const { createExtendedL1Client } = await import('@aztec/ethereum/client');
  const chain = createEthereumChain([l1Rpc], info.l1ChainId);
  const l1Client = createExtendedL1Client(chain.rpcUrls, l1Key, chain.chainInfo);

  const journal = openJournalDir(process.env.QUOTA_JOURNAL_DIR);
  try {
    const result = await bridgeFeeJuice(
      {
        node,
        l1Client: l1Client as never,
        journal,
        confirm: makeConfirm(flags),
        onProgress: (m) => console.log(`  ${m}`),
      },
      { to, amountWei },
    );
    console.log(`\nBridged ${formatFeeJuiceWei(result.amountWei)} to ${to}.`);
    console.log(`  message hash ${result.messageHash}`);
    console.log(`  leaf index   ${result.messageLeafIndex}`);
    console.log('  The claim secret is JOURNALED (not printed). Redeem with: claim --for <recipient>.');
  } finally {
    closeJournalDir(journal);
  }
}

async function cmdClaim(flags: Flags): Promise<void> {
  if (flags.has('help')) {
    console.log('claim --for 0x… [--message-hash 0x…] [--secret-stdin --amount-wei N --leaf-index N] [--yes]');
    console.log('Default reads the journal. --secret-stdin reads ONLY the secret from stdin.');
    return;
  }
  const recipient = requireString(flags, 'for');
  const { node, wallet, from } = await makeLocalContext(flags);
  const journal = openJournalDir(process.env.QUOTA_JOURNAL_DIR);
  try {
    const claim = flags.has('secret-stdin')
      ? {
          recipient,
          amountWei: BigInt(requireString(flags, 'amount-wei')),
          messageLeafIndex: BigInt(requireString(flags, 'leaf-index')),
          claimSecret: (await createInterface({ input: process.stdin }).question('claim secret: ')).trim(),
        }
      : findClaimInJournal(journal, {
          recipient,
          messageHash: flags.has('message-hash') ? String(flags.get('message-hash')) : undefined,
        });
    const { balanceBeforeWei, balanceAfterWei } = await claimFeeJuice(
      { node, wallet: wallet as never, from, confirm: makeConfirm(flags), journal },
      claim,
    );
    console.log(`\nClaimed. Balance ${formatFeeJuiceWei(balanceBeforeWei)} -> ${formatFeeJuiceWei(balanceAfterWei)}`);
  } finally {
    closeJournalDir(journal);
  }
}

async function cmdMeasure(flags: Flags): Promise<void> {
  if (flags.has('help')) {
    console.log('measure --fpc 0x… --count N   (drives sponsored sends via the test-target harness; local networks)');
    return;
  }
  // The full measurement pipeline needs the sponsored-send harness; it lands
  // with the integration suite (Phase 5 smoke drives it end-to-end).
  throw new Error('measure is exercised through the integration harness; see src/ts/test/integration.');
}

const COMMANDS: Record<string, (flags: Flags) => Promise<void>> = {
  deploy: cmdDeploy,
  policy: cmdPolicy,
  bridge: cmdBridge,
  claim: cmdClaim,
  measure: cmdMeasure,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    console.log(USAGE);
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`unknown command ${command}\n${USAGE}`);
    process.exit(2);
  }
  await handler(parseFlags(rest));
}

main().catch((err) => {
  if (process.env.QUOTA_CLI_DEBUG) console.error(err);
  else console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
