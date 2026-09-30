/**
 * Where Aztec lives on npm and git, and the pure rules the bump/release tooling applies to it.
 *
 * Aztec 6 moved `@aztec/*` to `@aztec-labs/*` (+ `@aztec-foundation/*` for the foundation-built
 * packages) and aztec-nr to its own repo. Every consumer of these constants must treat the
 * legacy names as an error, never as a synonym: a stale `@aztec/*` pin resolves to an
 * old-world package and would otherwise publish silently.
 */

/** Scopes pinned exactly to `config.aztecVersion`. */
export const LOCKSTEP_SCOPES = ['@aztec-labs/', '@aztec-foundation/'] as const;
export const LEGACY_SCOPE = '@aztec/';
/** Upstream still ships its viem fork under the legacy scope; the only legacy name allowed. */
export const ALLOWED_LEGACY_ALIAS = { name: 'viem', target: '@aztec/viem' } as const;

export const AZTEC_NR_GIT = 'https://github.com/aztec-labs-eng/aztec-nr';
export const LEGACY_AZTEC_NR_GITS = [
  'https://github.com/AztecProtocol/aztec-packages',
  'https://github.com/AztecProtocol/aztec-nr',
] as const;

export const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
export const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const isLockstepName = (name: string): boolean => LOCKSTEP_SCOPES.some((s) => name.startsWith(s));
export const isLegacyName = (name: string): boolean => name.startsWith(LEGACY_SCOPE);

/**
 * `npm:<target>[@<version>]` → its parts; undefined for a non-alias spec. An omitted or empty
 * version comes back as `''` rather than undefined: npm installs it as `*`, so callers must
 * see it and refuse it, not skip it.
 */
export function parseAlias(spec: string): { target: string; version: string } | undefined {
  const m = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/.exec(spec);
  return m?.[1] ? { target: m[1], version: m[2] ?? '' } : undefined;
}

const normalizeGit = (url: string): string => url.replace(/\/+$/, '');

/** The `git = "..."` URL on a Nargo.toml dependency line, trailing slashes stripped. */
export function nargoGitUrl(line: string): string | undefined {
  const m = /\bgit\s*=\s*"([^"]+)"/.exec(line);
  return m?.[1] ? normalizeGit(m[1]) : undefined;
}

/**
 * Rewrites the aztec-nr tag on one Nargo.toml line. Lines for other git deps (noir-lang crates)
 * pass through untouched; a line still pointing at a legacy aztec-nr home is an error because
 * upstream publishes no v6+ tags there — the sweep would produce an uncompilable manifest.
 */
export function sweepNargoLine(line: string, target: string): { line: string; error?: string } {
  const url = nargoGitUrl(line);
  if (!url) return { line };
  if ((LEGACY_AZTEC_NR_GITS as readonly string[]).includes(url)) {
    return { line, error: `legacy aztec-nr git URL ${url} — move the dependency to ${AZTEC_NR_GIT}` };
  }
  if (url !== AZTEC_NR_GIT) return { line };
  return { line: line.replace(/\btag\s*=\s*"v[0-9][^"]*"/, `tag = "v${target}"`) };
}

/**
 * One edge of the registry closure walk. A lockstep dependency pinned to anything other than
 * the target means upstream's labs and foundation versions diverged; the tooling has no second
 * version source yet, so that must stop the bump rather than be papered over.
 */
export function closureEdge(
  parent: string,
  dep: string,
  spec: string,
  target: string,
): { name: string; version: string } | { error: string } | undefined {
  const diverged = (name: string, version: string) => ({
    error: `${parent} depends on ${name}@${version}, which the lockstep ${target} does not satisfy — upstream versions diverged; extend the tooling before bumping`,
  });
  if (spec.startsWith('npm:')) {
    const alias = parseAlias(spec);
    if (!alias) return { error: `${parent}: unparseable alias ${dep}@${spec}` };
    if (isLockstepName(alias.target)) {
      return alias.version === target ? { name: alias.target, version: target } : diverged(alias.target, alias.version);
    }
    if (alias.target === ALLOWED_LEGACY_ALIAS.target) {
      return EXACT_SEMVER.test(alias.version)
        ? { name: alias.target, version: alias.version }
        : { error: `${parent}: ${dep} aliases ${alias.target}@${alias.version || '*'}, not an exact version` };
    }
    return undefined;
  }
  if (!isLockstepName(dep)) return undefined;
  // A range (`^5.0.1`, `*`) is only an edge to the target when bun would actually pick it.
  if (spec !== target && !(!EXACT_SEMVER.test(spec) && Bun.semver.satisfies(target, spec))) {
    return diverged(dep, spec);
  }
  return { name: dep, version: target };
}

export interface PublishRow {
  name: string;
  version: string;
  /** ISO publish time from the registry; undefined when the registry did not return one. */
  publishedAt: string | undefined;
}

/**
 * Names whose resolved version is still inside the min-age window. An unknown publish time is
 * an error: treating it as "old enough" would exempt nothing and let bun fail later, but treating
 * it as "young" would exempt a package nobody could date — neither is a decision to make silently.
 */
export function youngNames(rows: readonly PublishRow[], nowMs: number, minAgeMs = MIN_AGE_MS): string[] {
  const unknown = rows.filter((r) => !r.publishedAt || Number.isNaN(Date.parse(r.publishedAt)));
  if (unknown.length > 0) {
    throw new Error(`no publish time for: ${unknown.map((r) => `${r.name}@${r.version}`).join(', ')}`);
  }
  const young = rows.filter((r) => nowMs - Date.parse(r.publishedAt as string) < minAgeMs).map((r) => r.name);
  return [...new Set(young)].sort();
}

/**
 * Resolved `name -> versions` for every Aztec-scoped package in bun.lock. Legacy `@aztec/*`
 * entries are included on purpose: the viem alias resolves there, and any other legacy
 * package upstream still pulls belongs in the supply-chain report rather than out of it.
 */
export function lockfilePairs(lockText: string): Map<string, string[]> {
  const pairs = new Map<string, string[]>();
  const re = /"(@aztec(?:-labs|-foundation)?\/[a-z0-9._-]+)@([0-9][^"]*)"/gi;
  for (const m of lockText.matchAll(re)) {
    const [, name, version] = m;
    if (!name || !version) continue;
    const list = pairs.get(name) ?? [];
    if (!list.includes(version)) list.push(version);
    pairs.set(name, list);
  }
  return new Map([...pairs.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
