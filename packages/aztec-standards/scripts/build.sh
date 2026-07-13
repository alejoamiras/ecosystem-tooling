#!/usr/bin/env bash
set -euo pipefail

# Builds the publishable package layout IN the package directory (artifacts/ + target/ +
# deployments.json at package root), byte-compatible with the legacy defi-wonderland
# export/ assembly MINUS the dist/ mirror — that duplicate tree was carried through the
# rc releases for migration friction and removed at 5.0.0 as promised ("deprecate at
# stable"); deep imports use artifacts/… instead. Manifest stays curated directly
# (no lifecycle scripts, peer deps).

# ── Compile generated TS bindings → package-root artifacts/ ──────────────────
rm -rf artifacts dist deployments.json
mkdir -p artifacts
bunx tsc src/artifacts/*.ts --outDir artifacts/ --skipLibCheck --target es2020 --module nodenext --moduleResolution nodenext --resolveJsonModule --declaration

# ── Contract sanity check (kept from the legacy build) ───────────────────────
for f in target/*.json; do
  [ -f "$f" ] || continue
  aztec inspect-contract "$f"
done

# ── Drop inspect-contract backup files (they'd bloat the tarball) ────────────
rm -f target/*.json.bak

# ── deployments.json at package root (legacy path) ───────────────────────────
if [ -f "src/deployments.json" ]; then
  cp src/deployments.json deployments.json
else
  echo "src/deployments.json not found, skipping"
fi

echo "✔ Package layout ready (artifacts/ target/ deployments.json)"
