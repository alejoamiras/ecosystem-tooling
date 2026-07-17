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
# lags INDEPENDENTLY of version visibility. This runs ONLY on the recovery path (the version is
# already published), so it costs nothing on a fresh release and breaks early the moment the tag
# matches — only the failure case waits out the budget. So we give it the FULL documented lag
# (~600s: 30 reads, last at ~580s) rather than the shorter 300s the post-publish assert uses, so
# a correct-but-un-propagated tag is never false-aborted into the manual-OTP runbook. A single-
# shot read (as the two inline recovery checks originally used) would abort almost immediately.
# This one helper is the single source for both recovery sites.
#
# Usage: verify-dist-tag.sh <@scope/pkg> <expected-version> <dist-tag>
set -uo pipefail

PKG="${1:?pkg required}"
EXPECTED="${2:?expected version required}"
TAG="${3:?dist-tag required}"

tagged=""
for i in $(seq 1 30); do
  tags=$(npm view "$PKG" dist-tags --json 2>/dev/null || echo '{}')
  tagged=$(printf '%s' "$tags" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))['$TAG'] ?? ''" 2>/dev/null || echo '')
  [ "$tagged" = "$EXPECTED" ] && break
  [ "$i" -eq 30 ] || sleep 20  # no wasted trailing sleep after the final read
done

if [ "$tagged" != "$EXPECTED" ]; then
  echo "ERROR: recovery of $PKG@$EXPECTED but dist-tag '$TAG' points at '${tagged:-<unset>}', not $EXPECTED (after ~600s of read-lag retries)." >&2
  echo "If this is a set-latest revision, re-dispatch recovery with the SAME set-latest value as the original publish — the desired tag depends on it." >&2
  echo "OIDC cannot repair dist-tags; if the tag is genuinely wrong, fix it via the manual OTP runbook (docs/ci-pipeline.md) before re-running." >&2
  exit 1
fi
echo "dist-tag OK: $PKG '$TAG' -> $EXPECTED"
