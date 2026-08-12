/**
 * Schema-driven argv parsing.
 *
 * Schema-driven rather than permissive because the permissive version leaked:
 * a bare Map silently overwrote repeated flags (so a repeatable `--add-target`
 * could never accumulate), let unknown flags through unnoticed, and matched the
 * secret refusal on the exact token `--secret` — which `--secret=value` walks
 * straight past. Every flag here declares its arity, unknown and duplicate
 * flags are rejected, and the secret refusal matches the flag NAME in both
 * spellings.
 */

export interface FlagSpec {
  type: 'boolean' | 'string';
  /** String flags only: may appear more than once, values accumulate. */
  repeatable?: boolean;
}

export type FlagSchema = Record<string, FlagSpec>;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** Secrets never travel through argv — shell history and process listings leak. */
const REFUSED_FLAGS = new Set(['secret', 'claim-secret', 'private-key', 'l1-private-key']);

export interface ParsedFlags {
  has(name: string): boolean;
  /** Single-valued string flag, or undefined. */
  get(name: string): string | undefined;
  /** Repeatable string flag; always an array (possibly empty). */
  list(name: string): string[];
  /** Required single-valued string flag. */
  require(name: string): string;
}

/**
 * A required flag that must be an Aztec address, refused as a USAGE error.
 *
 * `AztecAddress.fromStringUnsafe` throws a bare Error ("Invalid AztecAddress
 * length 0."), which reaches the exit-1 bucket — "something may have happened"
 * — for a typo where nothing has happened at all (round-9).
 */
export function requireAddressFlag(flags: ParsedFlags, name: string): string {
  const value = flags.require(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new CliUsageError(`--${name} must be an Aztec address (0x + 64 hex), got "${value}"`);
  }
  return value;
}

export function parseFlags(argv: string[], schema: FlagSchema): ParsedFlags {
  const booleans = new Set<string>();
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      // Deliberately does NOT echo the token: a mistyped `--secret x` puts the
      // secret in the positional slot, and echoing it would copy it into logs.
      throw new CliUsageError(
        'unexpected positional argument (every input is a --flag; value withheld from this message)',
      );
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

    // BEFORE the schema lookup: refusing must not depend on the flag being
    // declared, and must catch --secret=value as surely as --secret value.
    if (REFUSED_FLAGS.has(name)) {
      throw new CliUsageError(
        `REFUSED: --${name} puts a secret into shell history and process listings. ` +
          `Use the journal (default), --secret-stdin, or the environment.`,
      );
    }

    // `help` is universal; every command answers it without touching a network.
    const spec: FlagSpec | undefined = name === 'help' ? { type: 'boolean' } : schema[name];
    if (!spec) {
      throw new CliUsageError(`unknown flag --${name}. Run with --help to see this command's flags.`);
    }

    if (spec.type === 'boolean') {
      if (inlineValue !== undefined) throw new CliUsageError(`--${name} is a boolean flag; it takes no value`);
      if (seen.has(name)) throw new CliUsageError(`--${name} was given more than once`);
      seen.add(name);
      booleans.add(name);
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new CliUsageError(`--${name} <value> requires a value`);
      value = next;
      i++;
    }

    if (spec.repeatable) {
      const bucket = lists.get(name) ?? [];
      bucket.push(value);
      lists.set(name, bucket);
    } else {
      if (seen.has(name)) throw new CliUsageError(`--${name} was given more than once`);
      seen.add(name);
      strings.set(name, value);
    }
  }

  return {
    has: (name) => booleans.has(name) || strings.has(name) || lists.has(name),
    get: (name) => strings.get(name),
    list: (name) => lists.get(name) ?? [],
    require: (name) => {
      const value = strings.get(name);
      if (value === undefined) throw new CliUsageError(`--${name} <value> is required`);
      return value;
    },
  };
}
