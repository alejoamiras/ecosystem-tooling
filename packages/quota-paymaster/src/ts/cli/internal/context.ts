/**
 * Turning `--config-module <path>` into a live OperatorContext.
 *
 * There is deliberately NO working-directory auto-discovery: loading a config
 * executes its code, before any confirmation gate, with whatever key material
 * the operator has in their environment. Requiring an explicit path means
 * running a command inside an untrusted checkout cannot execute that
 * checkout's code.
 */
import {
  loadOperatorConfigModule,
  OperatorConfigError,
  type OperatorContext,
  resolveOperatorContext,
} from '../../operator/config-module.js';
import type { ParsedFlags } from './flags.js';

export const CONFIG_MODULE_FLAG = 'config-module';

/** Resolves the operator context, or explains exactly what to write. */
export async function loadContext(flags: ParsedFlags): Promise<OperatorContext> {
  const path = flags.get(CONFIG_MODULE_FLAG);
  if (!path) {
    throw new OperatorConfigError(
      'not-found',
      `--${CONFIG_MODULE_FLAG} <path> is required (there is no automatic config discovery — a config ` +
        `module is code, and it must be code you chose to run). Minimal example:\n\n` +
        `  // quota-paymaster.config.mjs\n` +
        `  import { defineOperatorConfig, schnorrAccountFromEnv } from '@alejoamiras/quota-paymaster/operator/config';\n` +
        `  export default defineOperatorConfig(schnorrAccountFromEnv());\n`,
    );
  }
  const module = await loadOperatorConfigModule(path);
  return resolveOperatorContext(module);
}

/** Runs `fn` with the context and always releases it (deleting a temp key store). */
export async function withContext<T>(flags: ParsedFlags, fn: (context: OperatorContext) => Promise<T>): Promise<T> {
  const context = await loadContext(flags);
  try {
    return await fn(context);
  } finally {
    // dispose is OPERATOR code. Unguarded, a throw from it replaces the
    // command's outcome in both directions: a refusal's ActionAborted stops
    // being an ActionAborted (so the exit code becomes 1, "something may have
    // happened", for a dry run that sent nothing), and a SUCCESSFUL bridge
    // exits 1 right after printing success — inviting a second irreversible
    // deposit. Cleanup failing is worth a warning, never the verdict
    // (round-9 finding 1; config-module.ts already does this).
    try {
      await context.dispose?.();
    } catch (error) {
      console.warn(`warning: the config module's dispose() threw: ${(error as Error)?.message ?? error}`);
    }
  }
}
