#!/usr/bin/env bash
# Fail-closed dist-tag identity check for release.yml's recovery paths.
#
# OIDC credentials can only `npm publish`, never repair a dist-tag. So a legitimate recovery
# re-run must find the desired publish tag ALREADY pointing at the target version (a prior
# run's publish-time `--tag` sets it atomically with the publish). If it is absent/wrong AFTER
# the registry read-lag budget, we refuse: the operator fixes it via the manual OTP runbook; we
# never silently mutate a tag we cannot authorize.
#
# The npm read-API lag on package-level dist-tags is documented >10 min in release.yml and
# lags INDEPENDENTLY of version visibility — so the retry budget here matches the post-publish
# assert (15 x 20s = 300s), NOT the shorter version-visibility budget. A single-shot read (as
# the two inline recovery checks originally used) would false-abort a correct-but-un-propagated
# tag into the manual runbook. This one helper is the single source for both recovery sites.
#
# Usage: verify-dist-tag.sh <@scope/pkg> <expected-version> <dist-tag>
set -uo pipefail

PKG="${1:?pkg required}"
EXPECTED="${2:?expected version required}"
TAG="${3:?dist-tag required}"

tagged=""
for _ in $(seq 1 15); do
  tags=$(npm view "$PKG" dist-tags --json 2>/dev/null || echo '{}')
  tagged=$(printf '%s' "$tags" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))['$TAG'] ?? ''" 2>/dev/null || echo '')
  [ "$tagged" = "$EXPECTED" ] && break
  sleep 20
done

if [ "$tagged" != "$EXPECTED" ]; then
  echo "ERROR: recovery of $PKG@$EXPECTED but dist-tag '$TAG' points at '${tagged:-<unset>}', not $EXPECTED (after ~300s of read-lag retries)." >&2
  echo "If this is a set-latest revision, re-dispatch recovery with the SAME set-latest value as the original publish — the desired tag depends on it." >&2
  echo "OIDC cannot repair dist-tags; if the tag is genuinely wrong, fix it via the manual OTP runbook (docs/ci-pipeline.md) before re-running." >&2
  exit 1
fi
echo "dist-tag OK: $PKG '$TAG' -> $EXPECTED"
