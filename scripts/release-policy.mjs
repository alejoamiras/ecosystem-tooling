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
//   | rehearsal | 0.0.0-canary.g<sha>  | false      | canary      |
//   | revision  | <aztec>-revision.N   | false      | revision    |
//   | revision  | <aztec>-revision.N   | true       | latest      |
//   | non-revision (release/rehearsal) with set-latest=true  ->  REJECT

const MODES = ['release', 'rehearsal', 'revision'];
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;
const CANARY_RE = /^0\.0\.0-canary\.g[0-9a-f]{7,40}$/;
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
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    return { error: `invalid semver input: ${version}` };
  }
  if (typeof aztecVersion !== 'string' || !SEMVER_RE.test(aztecVersion)) {
    return { error: `invalid aztecVersion: ${aztecVersion}` };
  }
  if (typeof setLatest !== 'boolean') {
    return { error: `setLatest must be a boolean (got ${typeof setLatest})` };
  }

  const hasPre = version.includes('-');

  // Per-mode version shape.
  switch (mode) {
    case 'release':
      if (hasPre) {
        return { error: `release mode: version must be a plain X.Y.Z (got prerelease ${version})` };
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

// CLI: node scripts/release-policy.mjs <mode> <version> <aztecVersion> <setLatest>
// Prints `dist_tag=...` / `prerelease_flag=...` on stdout (for $GITHUB_OUTPUT); exit 1 on
// any policy violation with the reason on stderr.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, version, aztecVersion, setLatestRaw] = process.argv.slice(2);
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
  process.stdout.write(`dist_tag=${result.tag}\nprerelease_flag=${result.prereleaseFlag}\n`);
}
