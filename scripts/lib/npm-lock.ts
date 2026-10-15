import { type AztecVersions, foundationVersionOf, MIN_AGE_MS, type PublishRow, pinnedVersion } from './aztec-scopes.ts';
import { PUBLIC_REGISTRY } from './npm-registry.ts';

export interface LockedPackage {
  /** Install path, e.g. `node_modules/viem`. */
  slot: string;
  /** The real package: an aliased slot (`viem` → `@aztec/viem`) is identified by this, never by the slot. */
  name: string;
  version: string;
  resolved: string;
  integrity: string;
}

/** The only tarball URL the public registry serves for `name@version`. */
export const registryTarball = (name: string, version: string): string =>
  `${PUBLIC_REGISTRY}/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`;

/**
 * Every installed package of an npm v3 lockfile, root excluded. Throws unless each entry is a
 * public-registry tarball whose URL names the same package and version the entry claims and
 * carries an integrity hash: `npm ci` fetches `resolved` and checks `integrity`, so an entry
 * whose URL names another package would be dated and exempted under a name it does not install.
 */
export function lockPackages(lockText: string): LockedPackage[] {
  const lock = JSON.parse(lockText) as {
    lockfileVersion?: unknown;
    packages?: Record<string, Record<string, unknown>>;
  };
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('package-lock: expected lockfileVersion 3');
  const out: LockedPackage[] = [];
  const errors: string[] = [];
  for (const [slot, e] of Object.entries(lock.packages)) {
    if (slot === '') continue;
    const name = typeof e.name === 'string' ? e.name : slot.slice(slot.lastIndexOf('node_modules/') + 13);
    const { version, resolved, integrity } = e;
    if (typeof version !== 'string' || typeof resolved !== 'string' || typeof integrity !== 'string' || !integrity) {
      errors.push(`${slot}: needs version, resolved and integrity (link or non-registry entry?)`);
    } else if (resolved !== registryTarball(name, version)) {
      errors.push(`${slot}: resolved ${resolved} is not ${registryTarball(name, version)}`);
    } else {
      out.push({ slot, name, version, resolved, integrity });
    }
  }
  if (errors.length > 0) throw new Error(`package-lock:\n  ${errors.join('\n  ')}`);
  return out;
}

/**
 * The lockstep versions this toolchain lock may excuse from the min-age: `version` for the labs
 * scope, and for the foundation scope the one `@aztec-labs/aztec@<version>` pins according to the
 * public registry (`publicDeps`). The lock must agree: the resolver's metadata may come from a mirror.
 */
export function lockTargets(lockText: string, version: string, publicDeps: Record<string, string>): AztecVersions {
  const aztec = (
    JSON.parse(lockText) as { packages?: Record<string, { version?: string; dependencies?: Record<string, string> }> }
  ).packages?.['node_modules/@aztec-labs/aztec'];
  if (aztec?.version !== version)
    throw new Error(`package-lock: @aztec-labs/aztec is ${aztec?.version}, not ${version}`);
  const parent = `@aztec-labs/aztec@${version}`;
  const foundation = foundationVersionOf(parent, publicDeps);
  if (typeof foundation !== 'string') throw new Error(`registry: ${foundation.error}`);
  const locked = foundationVersionOf(parent, aztec.dependencies ?? {});
  if (locked !== foundation) {
    throw new Error(`package-lock: ${parent} pins foundation ${JSON.stringify(locked)}, the registry ${foundation}`);
  }
  return { aztecVersion: version, aztecFoundationVersion: foundation };
}

/**
 * The `name@version`s still inside the min-age window, split into those excused (an Aztec-scoped
 * name at exactly its scope's lockstep version) and every other one, a refusal: a young Aztec
 * name at any other version is not excused. A missing publish time throws; a future one is young.
 */
export function ageCheck(
  rows: readonly PublishRow[],
  nowMs: number,
  targets: AztecVersions,
  minAgeMs = MIN_AGE_MS,
): { youngAztec: string[]; tooYoung: string[] } {
  const undated = rows.filter((r) => !r.publishedAt || Number.isNaN(Date.parse(r.publishedAt)));
  if (undated.length > 0) {
    throw new Error(`no publish time for: ${undated.map((r) => `${r.name}@${r.version}`).join(', ')}`);
  }
  const young = rows.filter((r) => nowMs - Date.parse(r.publishedAt as string) < minAgeMs);
  const specs = (list: PublishRow[]) => [...new Set(list.map((r) => `${r.name}@${r.version}`))].sort();
  const excused = (r: PublishRow) => pinnedVersion(r.name, targets) === r.version;
  return { youngAztec: specs(young.filter(excused)), tooYoung: specs(young.filter((r) => !excused(r))) };
}
