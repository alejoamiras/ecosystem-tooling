/** `deploy` — validate a config, confirm the exact plan, deploy a paymaster. */
import { readFileSync } from 'node:fs';
import { parseQuotaFpcConfig, QuotaFpcConfigError } from '../../config/schema.js';
import { deployQuotaFpc } from '../../operator/deploy.js';
import { makeConfirm } from '../internal/confirm.js';
import { withContext } from '../internal/context.js';
import { CliUsageError, type FlagSchema, type ParsedFlags } from '../internal/flags.js';

export const schema: FlagSchema = {
  config: { type: 'string' },
  'config-module': { type: 'string' },
  yes: { type: 'boolean' },
  'allow-unverified-account-classes': { type: 'boolean' },
};

export const usage =
  'deploy --config <path.json> --config-module <path> [--yes] [--allow-unverified-account-classes]\n' +
  '  Without --yes: prints the plan and its digest, sends nothing.\n' +
  '  Config validation runs offline — a bad config fails before any network access.';

export async function run(flags: ParsedFlags): Promise<void> {
  const configPath = flags.require('config');
  // Offline first: a malformed config must never reach a wallet or a node.
  // An unreadable/unparseable file is a REFUSAL (nothing happened), not an
  // operational failure — the exit code must say so.
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new CliUsageError(`cannot read --config ${configPath}`);
  }
  let config: ReturnType<typeof parseQuotaFpcConfig>;
  try {
    config = parseQuotaFpcConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof QuotaFpcConfigError) throw error;
    throw new CliUsageError(`--config ${configPath} is not valid JSON`);
  }

  await withContext(flags, async (ctx) => {
    const contract = await deployQuotaFpc(
      {
        wallet: ctx.wallet,
        from: ctx.from,
        confirm: makeConfirm(flags),
        onWarn: (m) => console.warn(`  WARNING: ${m}`),
      },
      config,
      {
        allowUnverifiedAccountClasses: flags.has('allow-unverified-account-classes'),
        sendOptions: ctx.sendOptions,
      },
    );
    console.log(`\nDeployed. QUOTA_FPC_CONTRACT_ADDRESS=${contract.address.toString()}`);
    console.log('It holds no fee juice and sponsors nothing until funded. Fund LAST, in tranches —');
    console.log('fee juice cannot be withdrawn or moved once it lands.');
  });
}

export { QuotaFpcConfigError };
