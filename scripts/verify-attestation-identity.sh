#!/usr/bin/env bash
set -euo pipefail

# Provenance IDENTITY verification (plan aztec-5-stable D10): attestation PRESENCE is not
# enough — a valid attestation from the wrong repo/workflow/commit must not be accepted by
# recovery paths or release gates.
#
# Two layers:
#   1. `npm audit signatures` in a clean install of the exact package — Sigstore-verifies
#      registry signatures AND provenance attestations, bound to the package digest.
#   2. Parse the registry provenance bundle's DSSE payload (SLSA predicate) and assert the
#      identity fields: repository, workflow path, and (when provided) the commit SHA.
#
# Usage: verify-attestation-identity.sh <pkg> <version> [expected-sha]
#   expected-sha: full commit SHA the attestation must name (omit to skip the SHA check).

PKG="$1"; VERSION="$2"; EXPECTED_SHA="${3:-}"
EXPECTED_REPO="alejoamiras/ecosystem-tooling"
EXPECTED_WORKFLOW=".github/workflows/release.yml"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "verify-attestation-identity: $PKG@$VERSION (repo=$EXPECTED_REPO workflow=$EXPECTED_WORKFLOW sha=${EXPECTED_SHA:-<unchecked>})"

# Layer 1 — cryptographic verification bound to the package digest.
(cd "$WORK" \
  && npm init -y > /dev/null 2>&1 \
  && npm install "$PKG@$VERSION" --ignore-scripts --no-audit --no-fund --loglevel=error > /dev/null \
  && npm audit signatures > audit.out 2>&1) || { cat "$WORK/audit.out" 2>/dev/null; echo "ERROR: npm audit signatures failed for $PKG@$VERSION" >&2; exit 1; }
grep -q "verified attestation" "$WORK/audit.out" || grep -q "attestations" "$WORK/audit.out" || {
  cat "$WORK/audit.out"; echo "ERROR: audit signatures output shows no verified attestations" >&2; exit 1; }
if grep -qiE "invalid|missing signature" "$WORK/audit.out"; then
  cat "$WORK/audit.out"; echo "ERROR: audit signatures reported invalid/missing entries" >&2; exit 1
fi

# Layer 2 — identity fields from the (now crypto-verified) provenance bundle.
ATT_URL="$(npm view "$PKG@$VERSION" dist.attestations.url)"
[ -n "$ATT_URL" ] || { echo "ERROR: no attestations URL for $PKG@$VERSION" >&2; exit 1; }
curl -sf "$ATT_URL" -o "$WORK/attestations.json"

node -e "
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync('$WORK/attestations.json', 'utf8'));
  const atts = data.attestations ?? [];
  const prov = atts.find((a) => (a.predicateType ?? '').includes('slsa') || (a.predicateType ?? '').includes('provenance'));
  if (!prov) { console.error('ERROR: no provenance attestation in bundle (types: ' + atts.map(a=>a.predicateType).join(', ') + ')'); process.exit(1); }
  const payload = JSON.parse(Buffer.from(prov.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const pred = payload.predicate ?? {};
  // SLSA v1 (buildDefinition/runDetails) and v0.2 (invocation/builder) shapes both occur.
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
  const fail = (m) => { console.error('ERROR: ' + m); process.exit(1); };
  if (repo !== '$EXPECTED_REPO') fail('repository is ' + repo + ', expected $EXPECTED_REPO');
  if (!wfPath.includes('$EXPECTED_WORKFLOW')) fail('workflow path is ' + wfPath + ', expected $EXPECTED_WORKFLOW');
  if ('$EXPECTED_SHA' && sha !== '$EXPECTED_SHA') fail('commit is ' + sha + ', expected $EXPECTED_SHA');
  console.log('  ✓ identity verified: ' + repo + ' / ' + wfPath + ' @ ' + (sha || '<no sha in predicate>'));
"
