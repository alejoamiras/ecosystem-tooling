#!/usr/bin/env bash
set -euo pipefail

# Payload-identity comparison between a freshly built tarball and an authenticated
# registry baseline (plan aztec-5-stable phase 5.4): proves "same source SHA => same
# artifact" across rebuilds instead of assuming it (Nargo tags and the toolchain download
# are mutable inputs). Compares NORMALIZED tar entries — path, type, mode, link target,
# content digest — not just file lists. Only the allowed manifest fields (version +
# internal @alejoamiras/* pins) are normalized before diffing.
#
# Usage: compare-tarball-payload.sh <fresh.tgz> <baseline.tgz>

FRESH="$1"; BASELINE="$2"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for side in fresh baseline; do
  src="$FRESH"; [ "$side" = "baseline" ] && src="$BASELINE"
  mkdir -p "$WORK/$side"
  tar -xzf "$src" -C "$WORK/$side"
  # Normalize ONLY the allowed fields: version + internal pins (both differ between a
  # rehearsal baseline and a release build by design).
  node -e "
    const fs = require('fs');
    const p = '$WORK/$side/package/package.json';
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    pkg.version = '__NORMALIZED__';
    for (const s of ['dependencies', 'devDependencies', 'peerDependencies'])
      for (const n of Object.keys(pkg[s] ?? {}))
        if (n.startsWith('@alejoamiras/')) pkg[s][n] = '__NORMALIZED__';
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  "
  # Entry manifest: path, type, mode, link target, sha256 (dirs/symlinks digest-less).
  (cd "$WORK/$side" && find package -mindepth 1 -print0 | sort -z | while IFS= read -r -d '' f; do
    t="f"; [ -d "$f" ] && t="d"; [ -L "$f" ] && t="l"
    mode="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f")"
    link=""; [ "$t" = "l" ] && link="$(readlink "$f")"
    digest=""; [ "$t" = "f" ] && digest="$(shasum -a 256 "$f" | cut -d' ' -f1)"
    printf '%s|%s|%s|%s|%s\n' "$f" "$t" "$mode" "$link" "$digest"
  done) > "$WORK/$side.manifest"
done

if ! diff -u "$WORK/baseline.manifest" "$WORK/fresh.manifest"; then
  echo "compare-tarball-payload: DRIFT between $BASELINE and $FRESH (see diff above)" >&2
  exit 1
fi
echo "  ✓ payload identical (normalized): $(basename "$FRESH") == $(basename "$BASELINE")"
