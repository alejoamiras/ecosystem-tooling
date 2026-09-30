/**
 * Which QuotaFpc class ids this package vouches for, and how strongly.
 *
 * `mainnet` is the one class id ever checked against a live chain. `compiled` entries are
 * class ids this repo compiled and reviewed for later Aztec versions — a local pin, never
 * proof that anything is deployed, and no defence against an edit that changes source and
 * pin together. Callers must surface that difference, never flatten it to "verified".
 */

export interface KnownDeployments {
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

/** The reviewed anchor carrying this class id, if any. */
export function anchorForClassId(known: KnownDeployments, classId: string): LineageAnchor | undefined {
  return anchors(known).find((a) => a.classId === classId);
}

export const describeAnchor = (a: LineageAnchor): string =>
  `${a.classId} (Aztec ${a.aztecVersion}, ${a.chainVerified ? 'chain-verified' : 'locally pinned — not chain-verified'})`;
