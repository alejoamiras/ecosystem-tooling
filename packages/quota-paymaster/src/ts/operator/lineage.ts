/**
 * Which QuotaFpc class ids this package vouches for, and how strongly.
 *
 * `mainnet` is the one class id ever checked against a live chain. `compiled` entries are
 * class ids this repo compiled and reviewed for later Aztec versions — a local pin, never
 * proof that anything is deployed, and no defence against an edit that changes source and
 * pin together. Callers must surface that difference, never flatten it to "verified".
 */

export interface KnownDeployments {
  /** The Aztec version this package build targets; its anchor is the only one a deploy accepts. */
  currentAztecVersion: string;
  mainnet: { aztecVersion: string; classId: string; verifiedAgainstChain: boolean };
  compiled?: Record<string, { classId: string; verifiedAgainstChain: boolean }>;
}

export interface LineageAnchor {
  aztecVersion: string;
  classId: string;
  chainVerified: boolean;
}

const anchors = (known: KnownDeployments): LineageAnchor[] => [
  {
    aztecVersion: known.mainnet.aztecVersion,
    classId: known.mainnet.classId,
    chainVerified: known.mainnet.verifiedAgainstChain === true,
  },
  ...Object.entries(known.compiled ?? {}).map(([aztecVersion, c]) => ({
    aztecVersion,
    classId: c.classId,
    chainVerified: c.verifiedAgainstChain === true,
  })),
];

/** The anchor a build for `aztecVersion` must match. Throws when that version was never reviewed. */
export function selectAnchor(known: KnownDeployments, aztecVersion: string): LineageAnchor {
  const hit = anchors(known).find((a) => a.aztecVersion === aztecVersion);
  if (!hit) {
    throw new Error(
      `known-deployments.json has no lineage anchor for Aztec ${aztecVersion} — compile, review, and record compiled["${aztecVersion}"]`,
    );
  }
  return hit;
}

/**
 * The anchor for the Aztec version this package targets, provided `classId` is exactly its class.
 * An older reviewed class (a stale artifact from a previous Aztec version) is refused too: it is
 * reviewed, but not what this package build is.
 */
export function assertCurrentLineageClass(known: KnownDeployments, classId: string): LineageAnchor {
  const anchor = selectAnchor(known, known.currentAztecVersion);
  if (classId !== anchor.classId) {
    const other = anchors(known).find((a) => a.classId === classId);
    throw new Error(
      `The compiled QuotaFpc artifact's class id ${classId} is not this package's reviewed class ` +
        `${describeAnchor(anchor)}${other ? ` — it is the Aztec ${other.aztecVersion} class, a stale artifact` : ''}. ` +
        'Rebuild from clean sources (verify:lineage) before deploying.',
    );
  }
  return anchor;
}

export const describeAnchor = (a: LineageAnchor): string =>
  `${a.classId} (Aztec ${a.aztecVersion}, ${a.chainVerified ? 'chain-verified' : 'locally pinned — not chain-verified'})`;
