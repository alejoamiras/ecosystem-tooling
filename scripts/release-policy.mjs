// Dependency-free release-policy single source of truth.
//
// Given (mode, version, aztecVersion, setLatest) it validates the version SHAPE for the
// mode and derives the npm publish dist-tag + GitHub-release prerelease flag. This is the
// one place the tag matrix lives; release.yml calls it (CLI) and release-policy.test.mjs
// tests it (`node --test`), so a shell branch can never drift from the tested policy.
//
// It deliberately does NOT own the runtime/IO bindings that need the live checkout — the
// per-package `version === input` equality (release), the rehearsal "names THIS commit"
// check, and the expected-head-sha / compare-against SHA binding stay in the workflow.
//
// Policy matrix:
//   | mode      | version              | set-latest | publish tag |
//   |-----------|----------------------|------------|-------------|
//   | release   | X.Y.Z (== aztec)     | false      | latest      |
//   | release   | X.Y.Z-rc.N (== aztec)| false      | rc          |
//   | rehearsal | 0.0.0-canary.g<sha>  | false      | canary      |
//   | revision  | <aztec>-revision.N   | false      | revision    |
//   | revision  | <aztec>-revision.N   | true       | latest      |
//   | non-revision (release/rehearsal) with set-latest=true  ->  REJECT
//   | revision on a prerelease aztecVersion (6.0.0-rc.1-revision.N)  ->  REJECT

import { pathToFileURL } from 'node:url';

const MODES = ['release', 'rehearsal', 'revision'];
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;
const CANARY_RE = /^0\.0\.0-canary\.g[0-9a-f]{7,40}$/;
const RC_RE = /^[0-9]+\.[0-9]+\.[0-9]+-rc\.[1-9][0-9]*$/;
const NPM_TAG_RE = /^[a-z][a-z0-9-]*$/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {{mode:string, version:string, aztecVersion:string, setLatest:boolean}} input
 * @returns {{tag:string, prereleaseFlag:string} | {error:string}}
 */
export function computeReleasePolicy({ mode, version, aztecVersion, setLatest }) {
  if (!MODES.includes(mode)) {
    return { error: `unknown mode: ${mode} (expected one of ${MODES.join(', ')})` };
  }
  if (typeof aztecVersion !== 'string' || !SEMVER_RE.test(aztecVersion)) {
    return { error: `invalid aztecVersion: ${aztecVersion}` };
  }
  // Checked before the version shape so the rule is explicit rather than an accident of
  // SEMVER_RE (whose prerelease class has no '-', so `<rc>-revision.N` never parses anyway).
  // Ship the next rc instead: a revision sorts below its base and `@rc` would never reach it.
  if (mode === 'revision' && aztecVersion.includes('-')) {
    return {
      error: `revision mode: aztecVersion ${aztecVersion} is a prerelease — revisions of an rc are not supported`,
    };
  }
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    return { error: `invalid semver input: ${version}` };
  }
  if (typeof setLatest !== 'boolean') {
    return { error: `setLatest must be a boolean (got ${typeof setLatest})` };
  }

  const hasPre = version.includes('-');

  // Per-mode version shape.
  switch (mode) {
    case 'release':
      if (hasPre && !RC_RE.test(version)) {
        return { error: `release mode: version must be a plain X.Y.Z or X.Y.Z-rc.N (got prerelease ${version})` };
      }
      if (version !== aztecVersion) {
        return { error: `release mode: input ${version} != config.aztecVersion ${aztecVersion}` };
      }
      break;
    case 'rehearsal':
      if (!CANARY_RE.test(version)) {
        return { error: `rehearsal mode: version must be 0.0.0-canary.g<sha> (got ${version})` };
      }
      break;
    case 'revision': {
      const revisionRe = new RegExp(`^${escapeRe(aztecVersion)}-revision\\.[1-9][0-9]*$`);
      if (!revisionRe.test(version)) {
        return {
          error: `revision mode: version must be exactly ${aztecVersion}-revision.<N> with N>=1 (got ${version})`,
        };
      }
      break;
    }
  }

  // set-latest is a revision-only escape hatch (move `latest` onto a repo-side revision).
  if (setLatest && mode !== 'revision') {
    return { error: `set-latest is only valid in revision mode (got mode=${mode})` };
  }

  // Derive the publish dist-tag.
  let tag;
  if (setLatest) {
    tag = 'latest';
  } else if (!hasPre) {
    tag = 'latest';
  } else {
    // first dot-delimited segment of the prerelease (revision.1 -> revision, canary.gABC -> canary)
    tag = version.slice(version.indexOf('-') + 1).split('.')[0];
  }
  if (!NPM_TAG_RE.test(tag)) {
    return {
      error: `derived dist-tag '${tag}' is not a valid npm tag (prerelease segment must start with a letter, e.g. -revision.1)`,
    };
  }

  // The GitHub release is marked prerelease iff the VERSION string is a prerelease —
  // independent of set-latest (set-latest only moves the npm dist-tag, not the release kind).
  const prereleaseFlag = hasPre ? '--prerelease' : '';
  return { tag, prereleaseFlag };
}

/**
 * Which packages a dispatch may publish.
 *
 * A revision is inherently per-package: `<aztec>-revision.N` counts within ONE
 * package's history, and a single `version` input cannot carry two packages'
 * differing next numbers. So a revision names EXACTLY ONE package, and the
 * name-qualified tag (`<pkg>-v<version>`) is what disambiguates it. Release
 * and rehearsal keep publishing the full set by default.
 *
 * Returns the normalized, canonically-ordered list the workflow must use
 * everywhere downstream — never the raw input, so ⊆ / ordering / mode gating
 * cannot be bypassed by a job re-parsing the dispatch value itself.
 *
 * @param {{mode:string, packages:string, releasePackages:string}} input
 * @returns {{packages:string[]} | {error:string}}
 */
export function validatePackagesSubset({ mode, packages, releasePackages }) {
  if (!MODES.includes(mode)) return { error: `unknown mode: ${mode}` };
  const all = String(releasePackages ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (all.length === 0) return { error: 'releasePackages is empty — RELEASE_PACKAGES must list the release-ready set' };

  const requested = String(packages ?? '')
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);

  if (requested.length === 0) {
    if (mode === 'revision') {
      return {
        error: 'revision mode requires --packages naming exactly one package (a revision number is per-package)',
      };
    }
    return { packages: all };
  }

  const unknown = requested.filter((p) => !all.includes(p));
  if (unknown.length > 0) {
    return { error: `packages not in RELEASE_PACKAGES: ${unknown.join(', ')} (known: ${all.join(', ')})` };
  }
  const deduped = [...new Set(requested)];
  if (deduped.length !== requested.length) {
    return { error: `packages contains duplicates: ${requested.join(' ')}` };
  }

  if (mode === 'revision' && deduped.length !== 1) {
    return {
      error:
        `revision mode publishes exactly ONE package (got ${deduped.length}: ${deduped.join(', ')}). ` +
        'A shared version input cannot express differing per-package revision numbers.',
    };
  }

  // Canonical order is load-bearing (publish order), so normalize rather than
  // trusting the spelling on the dispatch form.
  return { packages: all.filter((p) => deduped.includes(p)) };
}

/**
 * SemVer 2.0 precedence for the X.Y.Z[-pre] shapes SEMVER_RE admits (no build metadata).
 * Throws on anything else: a comparator that guesses would turn a malformed registry value
 * into a pass on the forward-only tag check.
 *
 * @returns {-1 | 0 | 1}
 */
export function compareSemver(a, b) {
  for (const v of [a, b]) {
    if (typeof v !== 'string' || !SEMVER_RE.test(v)) throw new Error(`not a comparable semver: ${v}`);
  }
  const split = (v) => {
    const dash = v.indexOf('-');
    const core = (dash === -1 ? v : v.slice(0, dash)).split('.').map(Number);
    return { core, pre: dash === -1 ? [] : v.slice(dash + 1).split('.') };
  };
  const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return sign(x.core[i] - y.core[i]);
  // A release outranks every prerelease of the same core.
  if (x.pre.length === 0 || y.pre.length === 0) return sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    const [pn, qn] = [/^[0-9]+$/.test(p), /^[0-9]+$/.test(q)];
    if (pn && qn) return sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return sign(x.pre.length - y.pre.length);
}

// CLI: node scripts/release-policy.mjs --forward <current> <candidate>
// Exit 0 iff candidate > current; used before re-pointing an existing prerelease dist-tag.
//
// CLI: node scripts/release-policy.mjs <mode> <version> <aztecVersion> <setLatest> [packages] [releasePackages]
// Prints `dist_tag=...` / `prerelease_flag=...` on stdout (for $GITHUB_OUTPUT); exit 1 on
// any policy violation with the reason on stderr.
//
// Guard via pathToFileURL, NOT `file://${process.argv[1]}` string concat: a raw concat keeps a
// literal space (or other URL-encodable char) in the checkout path, while import.meta.url is
// percent-encoded — so on a runner whose work dir contains a space the guard would be false and
// the CLI block would silently no-op (exit 0, empty stdout → an empty dist-tag downstream).
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv[2] === '--forward') {
  const [current, candidate] = process.argv.slice(3);
  let order;
  try {
    order = compareSemver(candidate, current);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (order !== 1) {
    console.error(`${candidate} is not newer than ${current} — refusing to move the tag backwards or sideways`);
    process.exit(1);
  }
  process.stdout.write(`forward: ${current} -> ${candidate}\n`);
} else if (isMain) {
  const [mode, version, aztecVersion, setLatestRaw, packagesRaw, releasePackagesRaw] = process.argv.slice(2);
  if (setLatestRaw !== undefined && setLatestRaw !== 'true' && setLatestRaw !== 'false') {
    console.error(`set-latest must be 'true' or 'false' (got '${setLatestRaw}')`);
    process.exit(1);
  }
  const result = computeReleasePolicy({
    mode,
    version,
    aztecVersion,
    setLatest: setLatestRaw === 'true',
  });
  if ('error' in result) {
    console.error(result.error);
    process.exit(1);
  }
  let publishPackages = '';
  if (releasePackagesRaw !== undefined) {
    const subset = validatePackagesSubset({
      mode,
      packages: packagesRaw ?? '',
      releasePackages: releasePackagesRaw,
    });
    if ('error' in subset) {
      console.error(subset.error);
      process.exit(1);
    }
    publishPackages = subset.packages.join(' ');
  }
  process.stdout.write(
    `dist_tag=${result.tag}\nprerelease_flag=${result.prereleaseFlag}\n` +
      (publishPackages ? `publish_packages=${publishPackages}\n` : ''),
  );
}
