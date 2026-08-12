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
import { pathToFileURL } from 'node:url';
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
  // `name === undefined`, not falsy: `quota-paymaster ""` — an unset shell
  // variable — printed usage and exited 0, so a script's `set -e` sailed past
  // a command that never ran (round-15).
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    console.log(USAGE);
    return 0;
  }
  // hasOwn, not a plain lookup: `quota-paymaster constructor` walked the
  // prototype chain, found Object.prototype.constructor, and exited 0 printing
  // "undefined" instead of refusing an unknown command (round-13).
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
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

// Runs main when this file is executed DIRECTLY (`bun src/ts/cli/main.ts`,
// which the contributor flow and the CLI tests both use); the bin launcher and
// scripts/cli.ts import main() instead, and for them this is correctly false.
// pathToFileURL, not `file://` + the path: a checkout path containing a space
// (or anything needing percent-encoding) makes the string comparison false and
// the CLI would exit 0 having done nothing — the same trap
// scripts/release-policy.mjs documents (round-8 finding 3).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
