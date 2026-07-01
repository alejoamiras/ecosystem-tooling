#!/usr/bin/env bash
# lint-staged hook: format staged Noir files via aztec-nargo, grouped by nearest Nargo.toml.
# Portable to macOS bash 3.2 (no associative arrays).
set -euo pipefail

if ! command -v aztec-nargo >/dev/null 2>&1; then
  echo "aztec-nargo not found; skipping Noir fmt" >&2
  exit 0
fi

if [ "$#" -eq 0 ]; then
  exit 0
fi

printf '%s\n' "$@" | while IFS= read -r f; do
  d=$(dirname "$f")
  while [ "$d" != "." ] && [ "$d" != "/" ] && [ ! -f "$d/Nargo.toml" ]; do
    d=$(dirname "$d")
  done
  if [ -f "$d/Nargo.toml" ]; then
    echo "$d"
  fi
done | sort -u | while IFS= read -r p; do
  (cd "$p" && aztec-nargo fmt)
done
