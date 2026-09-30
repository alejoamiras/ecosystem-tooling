import { ALLOWED_LEGACY_ALIAS, EXACT_SEMVER, isLegacyName, isLockstepName, parseAlias } from './aztec-scopes.ts';

export const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

export interface Manifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export interface ManifestPolicy {
  aztecVersion: string;
  /** Publish paths only: the peer names the source manifest declares. */
  expectedPeers?: readonly string[];
  /** Publish paths only: the peers the source manifest marks optional. */
  expectedOptionalPeers?: readonly string[];
}

export const optionalPeers = (m: Manifest): string[] =>
  Object.entries(m.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta?.optional === true)
    .map(([name]) => name);

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * Every way a manifest can pin Aztec wrong, as error strings (empty = compliant).
 *
 * Aliases are judged by their TARGET, since the key is free text: `"foo": "npm:@aztec-labs/x@1"`
 * installs `@aztec-labs/x` exactly like a direct dep would.
 */
export function validateManifest(m: Manifest, policy: ManifestPolicy): string[] {
  const { aztecVersion } = policy;
  const errors: string[] = [];

  for (const section of DEP_SECTIONS) {
    for (const [name, spec] of Object.entries(m[section] ?? {})) {
      const at = `${section}.${name}`;
      if (isLegacyName(name)) {
        errors.push(`${at}: legacy @aztec/* name — use the @aztec-labs / @aztec-foundation successor`);
        continue;
      }
      if (isLockstepName(name) && spec !== aztecVersion) {
        errors.push(`${at} is ${spec}, expected exactly aztecVersion ${aztecVersion}`);
        continue;
      }
      const alias = parseAlias(spec);
      if (!alias) continue;
      if (isLockstepName(alias.target) && alias.version !== aztecVersion) {
        errors.push(`${at} aliases ${alias.target}@${alias.version}, expected exactly aztecVersion ${aztecVersion}`);
      } else if (isLegacyName(alias.target)) {
        const allowed = name === ALLOWED_LEGACY_ALIAS.name && alias.target === ALLOWED_LEGACY_ALIAS.target;
        if (!allowed) {
          errors.push(`${at} aliases legacy ${alias.target} — only viem → ${ALLOWED_LEGACY_ALIAS.target} is allowed`);
        } else if (!EXACT_SEMVER.test(alias.version)) {
          errors.push(`${at} aliases ${alias.target}@${alias.version}, expected an exact version`);
        }
      }
    }
  }

  const peers = Object.keys(m.peerDependencies ?? {});
  for (const name of Object.keys(m.peerDependenciesMeta ?? {})) {
    if (isLegacyName(name)) errors.push(`peerDependenciesMeta.${name}: legacy @aztec/* name`);
    if (!peers.includes(name)) errors.push(`peerDependenciesMeta.${name} has no matching peerDependencies entry`);
  }

  if (policy.expectedPeers) {
    if (!sameSet(peers, policy.expectedPeers)) {
      errors.push(
        `peer set [${[...peers].sort().join(', ')}] differs from the source manifest's [${[...policy.expectedPeers].sort().join(', ')}]`,
      );
    }
    if (!peers.some((p) => p.startsWith('@aztec-labs/'))) {
      errors.push('no @aztec-labs/* peer — a published package must pin the Aztec it was built against');
    }
  }
  if (policy.expectedOptionalPeers && !sameSet(optionalPeers(m), policy.expectedOptionalPeers)) {
    errors.push(
      `optional peers [${optionalPeers(m).sort().join(', ')}] differ from the source manifest's [${[...policy.expectedOptionalPeers].sort().join(', ')}]`,
    );
  }

  return errors;
}
