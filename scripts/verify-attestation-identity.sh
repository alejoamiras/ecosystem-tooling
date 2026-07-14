#!/usr/bin/env bash
set -euo pipefail

# Provenance IDENTITY verification (plan aztec-5-stable D10; post-audit rev 4).
#
# Identity comes from the certificate in the bundle NPM ITSELF VERIFIED — never from a
# re-fetched response, never from DSSE predicate content (predicates are produced by the
# attesting workflow; a re-fetch is a substitutable TOCTOU — both codex post-impl blockers):
#
#   1. `npm audit signatures --json --include-attestations` must list this exact
#      name@version in verified[] (absent from invalid[]/missing[]) — npm's sigstore
#      chain verification covered the TARGET. Installed --legacy-peer-deps so the audited
#      tree is the target plus real deps, not ~30 attested peers.
#   2. The verified entry's OWN `attestationBundles[]` (the bundles npm just verified — NOT
#      a re-fetch) supplies the SLSA-provenance bundle; its Fulcio certificate is the
#      identity source.
#   3. Certificate assertions (keyless identity is the SAN+issuer PAIR):
#        - SAN URI == the exact workflow identity (repo/workflow@ref),
#        - OIDC issuer (OID 1.3.6.1.4.1.57264.1.1) == GitHub Actions token endpoint,
#        - Source Repository Digest (OID 1.3.6.1.4.1.57264.1.13) == expected-sha,
#        - DSSE subject sha512 == registry dist.integrity (artifact binding).
#      A missing issuer, SAN, or (when a sha is requested) source-digest extension REFUSES.
#
# Registry reads retry (documented >10 min post-publish read lag; recovery paths run then).
#
# Usage: verify-attestation-identity.sh <pkg> <version> [expected-sha]

PKG="$1"; VERSION="$2"; EXPECTED_SHA="${3:-}"
EXPECTED_SAN="URI:https://github.com/alejoamiras/ecosystem-tooling/.github/workflows/release.yml@refs/heads/main"
EXPECTED_ISSUER="https://token.actions.githubusercontent.com"

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

echo "verify-attestation-identity: $PKG@$VERSION (san=$EXPECTED_SAN issuer=$EXPECTED_ISSUER sha=${EXPECTED_SHA:-<unchecked>})"

EXPECTED_INTEGRITY="$(view_retry "$PKG@$VERSION" dist.integrity)" || { echo "ERROR: cannot read dist.integrity" >&2; exit 1; }

(cd "$WORK" \
  && npm init -y > /dev/null 2>&1 \
  && npm install "$PKG@$VERSION" --legacy-peer-deps --ignore-scripts --no-audit --no-fund --loglevel=error > /dev/null \
  && npm audit signatures --json --include-attestations > audit.json 2> audit.err) || { cat "$WORK/audit.err" 2>/dev/null; echo "ERROR: npm audit signatures failed for $PKG@$VERSION" >&2; exit 1; }

PKG="$PKG" VERSION="$VERSION" EXPECTED_INTEGRITY="$EXPECTED_INTEGRITY" EXPECTED_SHA="$EXPECTED_SHA" \
EXPECTED_SAN="$EXPECTED_SAN" EXPECTED_ISSUER="$EXPECTED_ISSUER" node -e "
  const fs = require('fs');
  const { X509Certificate } = require('crypto');
  const fail = (m) => { console.error('ERROR: ' + m); process.exit(1); };
  const env = process.env;

  const d = JSON.parse(fs.readFileSync('$WORK/audit.json', 'utf8'));
  if ([...(d.invalid ?? []), ...(d.missing ?? [])].some((p) => p.name === env.PKG))
    fail(env.PKG + ' listed in invalid/missing by npm audit signatures');
  const t = (d.verified ?? []).find((p) => p.name === env.PKG && p.version === env.VERSION);
  if (!t) fail(env.PKG + '@' + env.VERSION + ' NOT in npm audit signatures verified[] — target attestation unverified');

  // The bundles npm JUST VERIFIED — no re-fetch (a re-fetch is substitutable).
  const prov = (t.attestationBundles ?? []).find((b) => (b.predicateType ?? '').includes('slsa') || (b.predicateType ?? '').includes('provenance'));
  if (!prov) fail('no verified SLSA-provenance bundle in the target entry');

  // Artifact binding.
  const payload = JSON.parse(Buffer.from(prov.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const expected = env.EXPECTED_INTEGRITY.replace(/^sha512-/, '');
  const subj = (payload.subject ?? []).find((s) => s.digest?.sha512);
  if (!subj) fail('provenance payload has no sha512 digest subject');
  if (Buffer.from(subj.digest.sha512, 'hex').toString('base64') !== expected)
    fail('provenance subject digest != registry dist.integrity — bundle is not about this artifact');

  // Certificate (keyless) identity.
  const vm = prov.bundle.verificationMaterial ?? {};
  const certB64 = vm.certificate?.rawBytes ?? vm.x509CertificateChain?.certificates?.[0]?.rawBytes;
  if (!certB64) fail('verified bundle carries no signing certificate');
  const der = Buffer.from(certB64, 'base64');
  const san = (new X509Certificate(der).subjectAltName ?? '').trim();
  if (san !== env.EXPECTED_SAN) fail('certificate SAN is \"' + san + '\", expected \"' + env.EXPECTED_SAN + '\"');

  // Fulcio custom extensions (node exposes no custom-extension API — DER-scan). Each is an
  // OID header followed shortly by its string value; scan a bounded window after the OID.
  // Fulcio extension value = OID, then an OCTET STRING (04 len) holding the value. Some
  // extensions store a raw string there (issuer .1.1); newer ones DER-wrap it again in a
  // string type (digest .1.13 = 04 <len> 0c <len> <utf8>). Honor the length prefixes
  // exactly (never charset-scan — trailing DER framing renders as printable bytes).
  const STRING_TAGS = new Set([0x0c, 0x13, 0x16, 0x1a]); // UTF8/Printable/IA5/Visible
  const extValue = (oidHex, label, required) => {
    const oid = Buffer.from(oidHex, 'hex');
    const at = der.indexOf(oid);
    if (at === -1) { if (required) fail('certificate lacks the ' + label + ' extension'); return ''; }
    let i = at + oid.length;
    if (der[i] === 0x01) i += 3; // optional BOOLEAN criticality (01 01 ff)
    if (der[i] !== 0x04) { if (required) fail('could not frame ' + label + ' value (no OCTET STRING)'); return ''; }
    let len = der[i + 1];
    let start = i + 2;
    if (STRING_TAGS.has(der[start])) { len = der[start + 1]; start += 2; } // unwrap inner string
    return der.subarray(start, start + len).toString('latin1');
  };
  const issuer = extValue('060a2b0601040183bf300101', 'OIDC issuer', true);
  if (issuer !== env.EXPECTED_ISSUER) fail('OIDC issuer is ' + JSON.stringify(issuer) + ', expected ' + env.EXPECTED_ISSUER);

  let certSha = '';
  if (env.EXPECTED_SHA) {
    certSha = extValue('060a2b0601040183bf30010d', 'Source Repository Digest', true).trim();
    if (certSha !== env.EXPECTED_SHA) fail('certificate source-digest is ' + certSha + ', expected ' + env.EXPECTED_SHA);
  }
  console.log('  ✓ identity verified (npm-verified cert): ' + san.replace(/^URI:/, '') + ' <' + issuer + '>' + (certSha ? ' @ ' + certSha : ''));
"
