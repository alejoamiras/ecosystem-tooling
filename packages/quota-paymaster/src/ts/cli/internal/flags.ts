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

const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * QUOTA_JOURNAL_DIR, or undefined when it is blank.
 *
 * `?? process.env.QUOTA_JOURNAL_DIR` alone accepted `" "` — flag values are
 * trimmed, the environment was not — and the journal then created a directory
 * literally named " " in the CURRENT directory. For anyone running this inside
 * a checkout that means claim secrets landing next to the code (round-15).
 */
export function journalDirFromEnv(): string | undefined {
  const raw = process.env.QUOTA_JOURNAL_DIR;
  // Blank is rejected; anything else is used VERBATIM. Trimming the value
  // itself would retarget a path that legitimately has leading or trailing
  // whitespace to a different directory (round-16).
  return raw?.trim() ? raw : undefined;
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
  // Shape is not enough: an Aztec address is a BN254 field element, and a
  // larger 64-hex value made AztecAddress throw its own error at exit 1 —
  // the bucket this guard exists to keep usage mistakes out of (round-10).
  if (BigInt(value) >= FIELD_MODULUS) {
    throw new CliUsageError(`--${name} is not a valid field element, so no Aztec address can equal it: ${value}`);
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
    // An EMPTY value is not a value: `--message-hash "$HASH"` with HASH unset
    // passed '' through, and every journal gate tests truthiness — so the
    // bookkeeping silently switched off and the next claim re-targeted an
    // already-claimed deposit. `--leaf-index ""` was worse: BigInt('') is 0n,
    // so it claimed leaf 0 (round-13).
    // trim(), not just '': BigInt(' ') is 0n too, so a whitespace-only
    // --leaf-index silently selected leaf 0 (round-14).
    if (value.trim() === '') throw new CliUsageError(`--${name} was given an empty value`);

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
