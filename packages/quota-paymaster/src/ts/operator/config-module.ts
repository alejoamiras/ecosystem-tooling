/**
 * The operator config-module pattern: how a human hands this library a signer
 * without ever putting key material on a command line.
 *
 * The operator writes a small module that default-exports
 * `defineOperatorConfig(factory)`, where `factory` returns the exact
 * {@link OperatorContext} the operator library already demands. The CLI's own
 * code contains no key material and reads no keys from argv — it loads the
 * module the operator explicitly named and calls the factory.
 *
 * LOADING A CONFIG MODULE EXECUTES USER CODE, before any ActionPlan gate. That
 * is why {@link loadOperatorConfigModule} is only ever reached from an explicit
 * `--config-module <path>`: there is NO working-directory auto-discovery, so
 * running a command inside an untrusted checkout cannot execute that
 * checkout's code with an operator's keys in the environment.
 */
import { pathToFileURL } from 'node:url';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Wallet } from '@aztec/aztec.js/wallet';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';
import type { GasProfile } from '../gas-profile.js';
import type { BridgeL1Client } from './bridge.js';

/** Everything the operator library needs, supplied by the operator's module. */
export interface OperatorContext {
  node: AztecNode;
  wallet: Wallet;
  /** The account operator actions are sent from. */
  from: AztecAddress;
  /** Merged into send options by commands that send (fee payment etc.). */
  sendOptions?: Record<string, unknown>;
  /** Required by policy/measure; deliberately has NO default (measure your own). */
  gasProfile?: GasProfile;
  /** Only the bridge command needs L1; absent ⇒ bridge fails with typed guidance. */
  l1?: { client: BridgeL1Client };
  /**
   * Released by the CLI in a `finally` when the command ends. This is how the
   * throwaway key store actually gets deleted: the Aztec wallet's own temp-store
   * cleanup runs on `delete()`, which nothing calls — `wallet.stop()` only
   * closes it — so a factory that wants its keys gone must own the directory
   * and remove it here (see schnorrAccountFromEnv).
   */
  dispose?: () => Promise<void>;
}

export type OperatorConfigFactory = () => Promise<OperatorContext>;

/** What a config module must default-export. */
export interface OperatorConfigModule {
  readonly __quotaPaymasterConfig: true;
  readonly load: OperatorConfigFactory;
}

export type OperatorConfigErrorReason =
  | 'not-found'
  | 'load-failed'
  | 'no-default-export'
  | 'not-defineOperatorConfig'
  | 'factory-threw'
  | 'shape-invalid'
  | 'loader-missing';

export class OperatorConfigError extends Error {
  constructor(
    readonly reason: OperatorConfigErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OperatorConfigError';
  }
}

/**
 * Wraps an operator's factory into the shape the CLI accepts.
 *
 * The returned object is validated STRUCTURALLY (brand property + shape), not
 * by instance identity: a CLI running from one copy of this package and a
 * config importing another copy (npx cache vs local install) are different
 * modules, so an identity check would reject a valid config.
 */
export function defineOperatorConfig(load: OperatorConfigFactory): OperatorConfigModule {
  if (typeof load !== 'function') {
    throw new OperatorConfigError(
      'shape-invalid',
      'defineOperatorConfig(factory) expects a function returning Promise<OperatorContext>',
    );
  }
  return Object.freeze({ __quotaPaymasterConfig: true as const, load });
}

function hasBrand(value: unknown): value is OperatorConfigModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __quotaPaymasterConfig?: unknown }).__quotaPaymasterConfig === true &&
    typeof (value as { load?: unknown }).load === 'function'
  );
}

/**
 * Picks the config out of a loaded module.
 *
 * `tsImport` returns TS modules through a CJS-interop wrapper, so the config
 * lands at `mod.default.default` there while a plain `.mjs` import puts it at
 * `mod.default` (proven in the Phase-1 spike). Unwrapping is BRAND-AWARE
 * rather than positional: blindly preferring `.default.default` would misfire
 * on a legitimate config object that happens to own a `default` property.
 */
function pickConfig(mod: Record<string, unknown>): unknown {
  const direct = mod.default;
  if (hasBrand(direct)) return direct;
  const nested = (direct as { default?: unknown } | undefined)?.default;
  if (hasBrand(nested)) return nested;
  // Return the most specific thing present so the error can describe it.
  return nested ?? direct;
}

const TS_EXTENSIONS = ['.ts', '.mts', '.cts'];

/**
 * Loads and validates an operator config module from an explicit path.
 *
 * `.mjs`/`.js` load via plain `import()` — no loader, no dependency. `.ts`
 * requires the optional `tsx` peer, resolvable from where THIS package is
 * installed (the config's own imports resolve from the config's location).
 */
export async function loadOperatorConfigModule(path: string): Promise<OperatorConfigModule> {
  const url = pathToFileURL(path).href;
  const isTypeScript = TS_EXTENSIONS.some((ext) => path.endsWith(ext));

  let mod: Record<string, unknown>;
  try {
    if (isTypeScript) {
      let tsImport: (specifier: string, parentUrl: string) => Promise<Record<string, unknown>>;
      try {
        ({ tsImport } = (await import('tsx/esm/api')) as unknown as {
          tsImport: typeof tsImport;
        });
      } catch (cause) {
        throw new OperatorConfigError(
          'loader-missing',
          `Loading a TypeScript config (${path}) needs the optional "tsx" dependency, resolvable from ` +
            `where @alejoamiras/quota-paymaster is installed. Install tsx, or use a .mjs config ` +
            `(which needs no loader at all).`,
          { cause },
        );
      }
      mod = await tsImport(url, import.meta.url);
    } else {
      mod = (await import(url)) as Record<string, unknown>;
    }
  } catch (cause) {
    if (cause instanceof OperatorConfigError) throw cause;
    const code = (cause as { code?: string } | undefined)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT') {
      throw new OperatorConfigError('not-found', `No config module at ${path}`, { cause });
    }
    throw new OperatorConfigError('load-failed', `Config module ${path} failed to load: ${describe(cause)}`, {
      cause,
    });
  }

  if (mod.default === undefined) {
    throw new OperatorConfigError(
      'no-default-export',
      `Config module ${path} has no default export. Expected: ` +
        `export default defineOperatorConfig(async () => ({ node, wallet, from }))`,
    );
  }

  const config = pickConfig(mod);
  if (!hasBrand(config)) {
    throw new OperatorConfigError(
      'not-defineOperatorConfig',
      `Config module ${path} must default-export defineOperatorConfig(...). ` +
        `If it does, the config may be importing a DIFFERENT copy of ` +
        `@alejoamiras/quota-paymaster than the CLI is running from (e.g. an npx cache alongside a ` +
        `local install) — install the package locally and run it from node_modules/.bin, or point ` +
        `both at the same install.`,
    );
  }
  return config;
}

/** Runs the operator's factory and validates what it returned. */
export async function resolveOperatorContext(module: OperatorConfigModule): Promise<OperatorContext> {
  let context: OperatorContext;
  try {
    context = await module.load();
  } catch (cause) {
    throw new OperatorConfigError('factory-threw', `The config factory threw: ${describe(cause)}`, { cause });
  }
  assertOperatorContext(context);
  return context;
}

/** Field-by-field so a wrong config names the field, never dumps a value. */
export function assertOperatorContext(context: unknown): asserts context is OperatorContext {
  if (typeof context !== 'object' || context === null) {
    throw new OperatorConfigError('shape-invalid', 'The config factory must resolve to an OperatorContext object');
  }
  const ctx = context as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof ctx.node !== 'object' || ctx.node === null) missing.push('node (AztecNode)');
  if (typeof ctx.wallet !== 'object' || ctx.wallet === null) missing.push('wallet (Wallet)');
  if (
    typeof ctx.from !== 'object' ||
    ctx.from === null ||
    typeof (ctx.from as { toString?: unknown }).toString !== 'function'
  ) {
    missing.push('from (AztecAddress)');
  }
  if (missing.length > 0) {
    throw new OperatorConfigError('shape-invalid', `OperatorContext is missing or malformed: ${missing.join(', ')}`);
  }
  if (ctx.sendOptions !== undefined && (typeof ctx.sendOptions !== 'object' || ctx.sendOptions === null)) {
    throw new OperatorConfigError('shape-invalid', 'OperatorContext.sendOptions must be an object when present');
  }
  if (ctx.l1 !== undefined) {
    // Validate what the bridge command actually dereferences, not just the
    // wrapper: a context with `l1: {}` would pass a shallow check and then fail
    // mid-bridge, after the confirmation gate.
    const l1 = ctx.l1 as { client?: unknown };
    if (typeof ctx.l1 !== 'object' || ctx.l1 === null || typeof l1.client !== 'object' || l1.client === null) {
      throw new OperatorConfigError('shape-invalid', 'OperatorContext.l1 must be { client } when present');
    }
  }
  if (ctx.dispose !== undefined && typeof ctx.dispose !== 'function') {
    throw new OperatorConfigError('shape-invalid', 'OperatorContext.dispose must be a function when present');
  }
  if (ctx.gasProfile !== undefined && (typeof ctx.gasProfile !== 'object' || ctx.gasProfile === null)) {
    throw new OperatorConfigError('shape-invalid', 'OperatorContext.gasProfile must be an object when present');
  }
}

/**
 * Enough to diagnose, never enough to leak.
 *
 * Errors contribute name + message (key-parse failures are sanitized where
 * they are raised, so their messages name fields, not values). A non-Error
 * throw contributes only its constructor name — a bare `typeof` (i.e.
 * "object") makes real failures undiagnosable, which cost a debugging cycle
 * during Phase 4.
 */
function describe(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'object' && cause !== null) {
    const name = (cause as { constructor?: { name?: string } }).constructor?.name ?? 'object';
    const message = (cause as { message?: unknown }).message;
    return typeof message === 'string' ? `${name}: ${message}` : name;
  }
  return typeof cause;
}
