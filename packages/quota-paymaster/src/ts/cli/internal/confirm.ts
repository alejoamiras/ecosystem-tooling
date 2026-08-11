/**
 * The confirmation gate every state-changing command passes through.
 *
 * Dry-run is not a separate code path that could drift out of sync with the
 * real one: WITHOUT `--yes` the confirm callback prints the plan and returns
 * false, so the operator library aborts before broadcasting. "Dry run" IS the
 * refused confirmation.
 */
import { createInterface } from 'node:readline/promises';
import type { ActionPlan, ConfirmAction } from '../../operator/action-plan.js';
import type { ParsedFlags } from './flags.js';

export function makeConfirm(flags: ParsedFlags, isTty: boolean = process.stdin.isTTY === true): ConfirmAction {
  return async (plan: ActionPlan): Promise<boolean> => {
    console.log(`\nAction plan: ${plan.kind}`);
    for (const [key, value] of Object.entries(plan.details)) {
      console.log(`  ${key.padEnd(26)} ${value}`);
    }
    console.log(`  digest                     ${plan.digest}`);
    if (!flags.has('yes')) {
      console.error('\nDry run: nothing was sent. Re-run with --yes to execute this exact plan.');
      return false;
    }
    if (!isTty) return true;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('\nProceed? Type the first 6 digest chars to confirm: ');
      return answer.trim() === plan.digest.slice(0, 6);
    } finally {
      rl.close();
    }
  };
}
