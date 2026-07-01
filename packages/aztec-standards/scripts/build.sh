#!/usr/bin/env bash
set -euo pipefail

# Builds the publishable package layout IN the package directory, byte-compatible with the
# legacy defi-wonderland export/ assembly (flat artifacts/ + flat dist/ mirror + target/ +
# deployments.json at package root). Replaces the old scripts/build-package.sh + jq trims —
# the manifest is now curated directly (no lifecycle scripts, peer deps; see plan D7/D15).

# ── Compile generated TS bindings → package-root artifacts/ ──────────────────
rm -rf artifacts dist deployments.json
mkdir -p artifacts
bunx tsc src/artifacts/*.ts --outDir artifacts/ --skipLibCheck --target es2020 --module nodenext --moduleResolution nodenext --resolveJsonModule --declaration

# ── Contract sanity check (kept from the legacy build) ───────────────────────
for f in target/*.json; do
  [ -f "$f" ] || continue
  aztec inspect-contract "$f"
done

# ── Legacy dist/ mirror (deep-import compatibility; deprecate at stable) ─────
cp -r artifacts dist

# ── deployments.json at package root (legacy path) ───────────────────────────
if [ -f "src/deployments.json" ]; then
  cp src/deployments.json deployments.json
else
  echo "src/deployments.json not found, skipping"
fi

echo "✔ Package layout ready (artifacts/ dist/ target/ deployments.json)"
