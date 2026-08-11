/**
 * The published operator CLI.
 *
 *   npx @alejoamiras/quota-paymaster <deploy|policy|bridge|claim|measure> [flags]
 *
 * ALWAYS invoke it scoped (or from a local install's node_modules/.bin). The
 * unscoped name is not this package.
 *
 * Two invariants hold across every command:
 *  - Nothing that changes state runs without `--yes`. Without it the command
 *    prints the exact ActionPlan and its digest, then stops.
 *  - Secrets never travel through argv. The claim secret lives in the hardened
 *    journal; keys are read from the environment by the operator's own config
 *    module, which the CLI's code never inspects.
 *
 * Exit codes: 0 success · 2 refused (aborted plan, rejected config, usage) ·
 * 1 operational failure.
 */
import { QuotaFpcConfigError } from '../config/schema.js';
import { ActionAborted } from '../operator/action-plan.js';
import { OperatorConfigError } from '../operator/config-module.js';
import * as bridge from './commands/bridge.js';
import * as claim from './commands/claim.js';
import * as deploy from './commands/deploy.js';
import * as measure from './commands/measure.js';
import * as policy from './commands/policy.js';
import { CliUsageError, type FlagSchema, type ParsedFlags, parseFlags } from './internal/flags.js';

interface Command {
  schema: FlagSchema;
  usage: string;
  run: (flags: ParsedFlags) => Promise<void>;
}

const COMMANDS: Record<string, Command> = { deploy, policy, bridge, claim, measure };

const USAGE = `Usage: npx @alejoamiras/quota-paymaster <command> [flags]

Commands:
  deploy    deploy a QuotaFpc paymaster from a validated config
  policy    read the live/pending policy; schedule or cancel a change
  bridge    deposit L1 $AZTEC into Aztec fee juice (IRREVERSIBLE)
  claim     redeem a bridged deposit for a recipient
  measure   drive real sponsored transactions and report their cost

Every command needs --config-module <path> (a module you wrote that supplies the
signer); state-changing commands need --yes to actually send. Run
"<command> --help" for that command's flags.

Secrets are never accepted on argv.`;

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    console.log(USAGE);
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    console.error(`unknown command ${name}\n\n${USAGE}`);
    return 2;
  }

  try {
    const flags = parseFlags(rest, command.schema);
    if (flags.has('help')) {
      console.log(command.usage);
      return 0;
    }
    await command.run(flags);
    return 0;
  } catch (error) {
    // Refusals are distinct from failures: an operator who declined a plan, a
    // rejected config, or a usage mistake all mean "nothing happened".
    if (
      error instanceof ActionAborted ||
      error instanceof CliUsageError ||
      error instanceof QuotaFpcConfigError ||
      error instanceof OperatorConfigError
    ) {
      console.error(`\n${error.message}`);
      return 2;
    }
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    if (process.env.QUOTA_CLI_DEBUG && error instanceof Error) console.error(error.stack);
    return 1;
  }
}

// Executed directly (via the bin launcher), not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
