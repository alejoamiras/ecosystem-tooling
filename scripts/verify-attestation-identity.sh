#!/usr/bin/env bash
set -euo pipefail

# Provenance IDENTITY verification (plan aztec-5-stable D10): attestation PRESENCE is not
# enough — a valid attestation from the wrong repo/workflow/commit must not be accepted by
# recovery paths or release gates.
#
# Layers (post code-review hardening):
#   1. `npm audit signatures` on a clean install of the TARGET package with
#      --legacy-peer-deps (peers are NOT auto-installed, so the audited tree is the target
#      plus its real deps — the tree-wide "verified" count can no longer be satisfied by
#      ~30 attested @aztec peer dependencies while the target itself was skipped).
#   2. Bind the registry provenance bundle to the artifact: the DSSE payload's subject
#      digest must equal the registry dist.integrity sha512 for this exact tarball.
#   3. Assert the identity fields (repository, workflow path, optional commit SHA) from
#      that subject-bound payload.
# Registry reads retry (the repo's documented read-API lag exceeds 10 minutes right after
# publishes; this script is used in recovery paths that run in exactly that window).
#
# Usage: verify-attestation-identity.sh <pkg> <version> [expected-sha]

PKG="$1"; VERSION="$2"; EXPECTED_SHA="${3:-}"
EXPECTED_REPO="alejoamiras/ecosystem-tooling"
EXPECTED_WORKFLOW=".github/workflows/release.yml"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

view_retry() { # npm view with retry for post-publish read lag
  local out
  for _ in 1 2 3 4 5; do
    out="$(npm view "$@" 2>/dev/null)" && [ -n "$out" ] && { printf '%s\n' "$out"; return 0; }
    sleep 15
  done
  return 1
}

echo "verify-attestation-identity: $PKG@$VERSION (repo=$EXPECTED_REPO workflow=$EXPECTED_WORKFLOW sha=${EXPECTED_SHA:-<unchecked>})"

# Layer 1 — cryptographic verification, attributed to (approximately) the target tree.
(cd "$WORK" \
  && npm init -y > /dev/null 2>&1 \
  && npm install "$PKG@$VERSION" --legacy-peer-deps --ignore-scripts --no-audit --no-fund --loglevel=error > /dev/null \
  && npm audit signatures > audit.out 2>&1) || { cat "$WORK/audit.out" 2>/dev/null; echo "ERROR: npm audit signatures failed for $PKG@$VERSION" >&2; exit 1; }
grep -qE "verified attestation" "$WORK/audit.out" || {
  cat "$WORK/audit.out"; echo "ERROR: audit signatures shows no verified attestations in the target tree" >&2; exit 1; }
if grep -qiE "invalid|missing registry signature|missing signature" "$WORK/audit.out"; then
  cat "$WORK/audit.out"; echo "ERROR: audit signatures reported invalid/missing entries" >&2; exit 1
fi

# Layer 2 — fetch the bundle and bind it to the artifact digest.
EXPECTED_INTEGRITY="$(view_retry "$PKG@$VERSION" dist.integrity)" || { echo "ERROR: cannot read dist.integrity for $PKG@$VERSION" >&2; exit 1; }
ATT_URL="$(view_retry "$PKG@$VERSION" dist.attestations.url)" || { echo "ERROR: no attestations URL for $PKG@$VERSION" >&2; exit 1; }
for _ in 1 2 3; do curl -sf "$ATT_URL" -o "$WORK/attestations.json" && break; sleep 10; done
[ -s "$WORK/attestations.json" ] || { echo "ERROR: could not fetch attestation bundle" >&2; exit 1; }

EXPECTED_INTEGRITY="$EXPECTED_INTEGRITY" EXPECTED_SHA="$EXPECTED_SHA" EXPECTED_REPO="$EXPECTED_REPO" EXPECTED_WORKFLOW="$EXPECTED_WORKFLOW" node -e "
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync('$WORK/attestations.json', 'utf8'));
  const atts = data.attestations ?? [];
  const prov = atts.find((a) => (a.predicateType ?? '').includes('slsa') || (a.predicateType ?? '').includes('provenance'));
  if (!prov) { console.error('ERROR: no provenance attestation in bundle (types: ' + atts.map(a=>a.predicateType).join(', ') + ')'); process.exit(1); }
  const payload = JSON.parse(Buffer.from(prov.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const fail = (m) => { console.error('ERROR: ' + m); process.exit(1); };

  // Subject binding: this bundle must attest THIS tarball (registry sha512 integrity).
  const expected = process.env.EXPECTED_INTEGRITY.replace(/^sha512-/, '');
  const subj = (payload.subject ?? []).find((s) => s.digest && (s.digest.sha512 || s.digest.sha256));
  if (!subj) fail('provenance payload has no digest subject');
  const gotB64 = subj.digest.sha512 ? Buffer.from(subj.digest.sha512, 'hex').toString('base64') : null;
  if (!gotB64) fail('provenance subject lacks a sha512 digest (got: ' + Object.keys(subj.digest).join(',') + ')');
  if (gotB64 !== expected) fail('provenance subject digest does not match registry dist.integrity — bundle is not about this artifact');

  const pred = payload.predicate ?? {};
  const ext = pred.buildDefinition?.externalParameters?.workflow ?? {};
  const repoV1 = (ext.repository ?? '').replace(/^https:\/\/github.com\//, '');
  const shaV1 = (pred.buildDefinition?.resolvedDependencies ?? [])[0]?.digest?.gitCommit ?? '';
  const pathV1 = ext.path ?? '';
  const cfg = pred.invocation?.configSource ?? {};
  const repoV02 = (cfg.uri ?? '').replace(/^git\+https:\/\/github.com\//, '').split('@')[0];
  const shaV02 = cfg.digest?.sha1 ?? '';
  const pathV02 = (cfg.entryPoint ?? '');
  const repo = repoV1 || repoV02;
  const sha = shaV1 || shaV02;
  const wfPath = pathV1 || pathV02;
  if (repo !== process.env.EXPECTED_REPO) fail('repository is ' + repo + ', expected ' + process.env.EXPECTED_REPO);
  if (!wfPath.includes(process.env.EXPECTED_WORKFLOW)) fail('workflow path is ' + wfPath + ', expected ' + process.env.EXPECTED_WORKFLOW);
  if (process.env.EXPECTED_SHA && sha !== process.env.EXPECTED_SHA) fail('commit is ' + sha + ', expected ' + process.env.EXPECTED_SHA);
  console.log('  ✓ identity verified (subject-bound): ' + repo + ' / ' + wfPath + ' @ ' + (sha || '<no sha in predicate>'));
"
