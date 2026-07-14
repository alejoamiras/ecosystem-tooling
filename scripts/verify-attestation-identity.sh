#!/usr/bin/env bash
set -euo pipefail

# Provenance IDENTITY verification (plan aztec-5-stable D10; post-audit rev 3).
#
# Identity comes from the VERIFIED SIGNING CERTIFICATE, never from DSSE predicate
# content (predicates are produced by the attesting workflow itself — GitHub documents
# them as manipulable by the originating workflow; codex post-impl blocker):
#
#   1. Attribution: `npm audit signatures --json` must list EXACTLY this name@version in
#      verified[] (and it must be absent from invalid[]/missing[]) — npm's sigstore
#      verification covered the TARGET, not just attested peers. Installed with
#      --legacy-peer-deps so the audited tree is the target plus its real deps.
#   2. Artifact binding: the provenance bundle's DSSE subject sha512 must equal the
#      registry dist.integrity for this exact tarball, and the bundle is fetched from
#      the same attestations URL npm's verified entry names.
#   3. Signer identity: parse the bundle's Fulcio certificate —
#        - SAN URI must EXACTLY equal the expected workflow identity
#          (https://github.com/<repo>/<workflow>@refs/heads/main),
#        - the Source Repository Digest extension (OID 1.3.6.1.4.1.57264.1.13,
#          DER-scanned; node exposes no custom-extension API) must equal expected-sha.
#      Predicate fields are not consulted for identity at all.
#
# Registry reads retry (documented >10 min post-publish read lag; recovery paths run
# in exactly that window).
#
# Usage: verify-attestation-identity.sh <pkg> <version> [expected-sha]

PKG="$1"; VERSION="$2"; EXPECTED_SHA="${3:-}"
EXPECTED_SAN="URI:https://github.com/alejoamiras/ecosystem-tooling/.github/workflows/release.yml@refs/heads/main"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

view_retry() {
  local out
  for _ in 1 2 3 4 5; do
    out="$(npm view "$@" 2>/dev/null)" && [ -n "$out" ] && { printf '%s\n' "$out"; return 0; }
    sleep 15
  done
  return 1
}

echo "verify-attestation-identity: $PKG@$VERSION (san=$EXPECTED_SAN sha=${EXPECTED_SHA:-<unchecked>})"

# Layer 1 — attributed cryptographic verification.
(cd "$WORK" \
  && npm init -y > /dev/null 2>&1 \
  && npm install "$PKG@$VERSION" --legacy-peer-deps --ignore-scripts --no-audit --no-fund --loglevel=error > /dev/null \
  && npm audit signatures --json --include-attestations > audit.json 2> audit.err) || { cat "$WORK/audit.err" 2>/dev/null; echo "ERROR: npm audit signatures failed for $PKG@$VERSION" >&2; exit 1; }

ATT_URL="$(PKG="$PKG" VERSION="$VERSION" node -e "
  const d = JSON.parse(require('fs').readFileSync('$WORK/audit.json', 'utf8'));
  const bad = [...(d.invalid ?? []), ...(d.missing ?? [])].find((p) => p.name === process.env.PKG);
  if (bad) { console.error('ERROR: ' + process.env.PKG + ' listed in invalid/missing by npm audit signatures'); process.exit(1); }
  const t = (d.verified ?? []).find((p) => p.name === process.env.PKG && p.version === process.env.VERSION);
  if (!t) { console.error('ERROR: ' + process.env.PKG + '@' + process.env.VERSION + ' NOT in npm audit signatures verified[] — target attestation unverified'); process.exit(1); }
  if (!t.attestations?.url) { console.error('ERROR: verified entry has no attestations url'); process.exit(1); }
  console.log(t.attestations.url);
")" || exit 1
echo "  ✓ npm verified the target's registry signature + attestation ($ATT_URL)"

# Layer 2 — fetch THE bundle npm's verified entry names; bind it to the artifact digest.
EXPECTED_INTEGRITY="$(view_retry "$PKG@$VERSION" dist.integrity)" || { echo "ERROR: cannot read dist.integrity" >&2; exit 1; }
for _ in 1 2 3; do curl -sf "$ATT_URL" -o "$WORK/attestations.json" && break; sleep 10; done
[ -s "$WORK/attestations.json" ] || { echo "ERROR: could not fetch attestation bundle" >&2; exit 1; }

# Layer 3 — certificate-bound identity.
EXPECTED_INTEGRITY="$EXPECTED_INTEGRITY" EXPECTED_SHA="$EXPECTED_SHA" EXPECTED_SAN="$EXPECTED_SAN" node -e "
  const fs = require('fs');
  const { X509Certificate } = require('crypto');
  const fail = (m) => { console.error('ERROR: ' + m); process.exit(1); };

  const data = JSON.parse(fs.readFileSync('$WORK/attestations.json', 'utf8'));
  const prov = (data.attestations ?? []).find((a) => (a.predicateType ?? '').includes('slsa') || (a.predicateType ?? '').includes('provenance'));
  if (!prov) fail('no provenance attestation in bundle');

  // Artifact binding: subject digest == registry integrity for this tarball.
  const payload = JSON.parse(Buffer.from(prov.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const expected = process.env.EXPECTED_INTEGRITY.replace(/^sha512-/, '');
  const subj = (payload.subject ?? []).find((s) => s.digest?.sha512);
  if (!subj) fail('provenance payload has no sha512 digest subject');
  if (Buffer.from(subj.digest.sha512, 'hex').toString('base64') !== expected)
    fail('provenance subject digest does not match registry dist.integrity — bundle is not about this artifact');

  // Signer identity from the VERIFIED CERTIFICATE (never the predicate).
  const vm = prov.bundle.verificationMaterial ?? {};
  const certB64 = vm.certificate?.rawBytes ?? vm.x509CertificateChain?.certificates?.[0]?.rawBytes;
  if (!certB64) fail('bundle carries no signing certificate');
  const der = Buffer.from(certB64, 'base64');
  const cert = new X509Certificate(der);
  const san = (cert.subjectAltName ?? '').trim();
  if (san !== process.env.EXPECTED_SAN)
    fail('certificate SAN is \"' + san + '\", expected \"' + process.env.EXPECTED_SAN + '\"');

  // Source Repository Digest extension (Fulcio OID 1.3.6.1.4.1.57264.1.13): DER-scan —
  // node's X509Certificate exposes no custom extensions. OID encodes to
  // 06 0a 2b 06 01 04 01 83 bf 30 01 0d; the value is an OCTET STRING wrapping a
  // UTF8/octet payload holding the 40-char commit sha.
  let certSha = '';
  const oid = Buffer.from('060a2b0601040183bf30010d', 'hex');
  const at = der.indexOf(oid);
  if (at !== -1) {
    const window = der.subarray(at + oid.length, at + oid.length + 64).toString('latin1');
    const m = window.match(/[0-9a-f]{40}/);
    if (m) certSha = m[0];
  }
  if (process.env.EXPECTED_SHA) {
    if (certSha) {
      if (certSha !== process.env.EXPECTED_SHA)
        fail('certificate source-digest is ' + certSha + ', expected ' + process.env.EXPECTED_SHA);
    } else {
      // No parsable cert extension: refuse rather than falling back to predicate claims.
      fail('certificate lacks a parsable Source Repository Digest extension — cannot bind commit sha');
    }
  }
  console.log('  ✓ identity verified (certificate-bound): ' + san.replace(/^URI:/, '') + (certSha ? ' @ ' + certSha : ''));
"
