#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="@wonderland/aztec-fee-payment"
EXPORT_DIR="export/${PROJECT_NAME}"

# ── Compile TS SDK to JS ─────────────────────────────────────────
# Compile the SDK source (index.ts, fee-payment-methods/, utils/)
# and artifact bindings (src/artifacts/) into dist/
yarn tsc --project tsconfig.build.json

# ── Prepare export directory ─────────────────────────────────────
rm -rf export/
mkdir -p "${EXPORT_DIR}/dist"

# Copy compiled JS output
cp -r dist/* "${EXPORT_DIR}/dist/"

# Copy compiled Noir contracts (needed by consumers for artifact loading)
cp -r target "${EXPORT_DIR}/"

# Copy docs
cp README.md "${EXPORT_DIR}/" 2>/dev/null || true
[ -f LICENSE ] && cp LICENSE "${EXPORT_DIR}/"

# Create trimmed package.json with proper exports
jq 'del(.scripts, .jest, ."lint-staged", .packageManager, .devDependencies, .dependencies, .engines, .resolutions, .private)
    | .name = "'"${PROJECT_NAME}"'"' \
  package.json > "${EXPORT_DIR}/package.json"

echo "✔ Package prepared at ${EXPORT_DIR}"
