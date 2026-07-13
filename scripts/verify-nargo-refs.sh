#!/usr/bin/env bash
set -euo pipefail

# Nargo git deps pin MUTABLE tags (ecosystem practice) — a silently moved upstream tag
# would change the bytecode we compile and publish. This script freezes tag->commit
# identity in nargo-deps.lock.json and enforces it on every build (plan aztec-5-stable D5).
#
#   scripts/verify-nargo-refs.sh --write   # (re)generate the lock from Nargo.toml manifests
#   scripts/verify-nargo-refs.sh           # verify, BIDIRECTIONALLY:
#                                          #   - every manifest git dep has a lock entry
#                                          #   - every locked (url, tag) still resolves to its commit
#
# Exit non-zero on any mismatch, unlocked dep, or unresolvable ref.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/nargo-deps.lock.json"
MODE="${1:-verify}"

# (url<TAB>tag) pairs from every packages/**/Nargo.toml, deduped.
# Field order inside the inline table varies (git before tag AND tag before git exist
# in this repo) — extract each field independently instead of assuming an order.
manifest_pairs() {
  find "$ROOT/packages" -name Nargo.toml -not -path '*/node_modules/*' -print0 |
    xargs -0 grep -h -E 'git *= *"' |
    awk '{
      url=""; tag="";
      if (match($0, /git *= *"[^"]+"/))  { url=substr($0, RSTART, RLENGTH); gsub(/git *= *"|"/, "", url); }
      if (match($0, /tag *= *"[^"]+"/))  { tag=substr($0, RSTART, RLENGTH); gsub(/tag *= *"|"/, "", tag); }
      if (url != "" && tag != "") { sub(/\/+$/, "", url); print url "\t" tag; }
    }' | sort -u
}

resolve() { # url tag -> commit sha (annotated tags: prefer ^{} peeled line)
  local url="$1" tag="$2" out
  out="$(git ls-remote "$url" "refs/tags/${tag}" "refs/tags/${tag}^{}" "refs/heads/${tag}" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  # peeled (^{}) wins, else first match
  printf '%s\n' "$out" | awk '/\^\{\}$/{print $1; found=1; exit} {if(!seen){first=$1; seen=1}} END{if(!found && seen) print first}'
}

if [ "$MODE" = "--write" ]; then
  tmp="$(mktemp)"
  echo '{' > "$tmp"
  first=1
  while IFS=$'\t' read -r url tag; do
    sha="$(resolve "$url" "$tag")" || { echo "ERROR: cannot resolve $url @ $tag" >&2; exit 1; }
    [ $first -eq 1 ] || echo ',' >> "$tmp"
    printf '  "%s@%s": "%s"' "$url" "$tag" "$sha" >> "$tmp"
    first=0
    echo "locked: $url @ $tag -> $sha" >&2
  done < <(manifest_pairs)
  printf '\n}\n' >> "$tmp"
  mv "$tmp" "$LOCK"
  echo "wrote $LOCK"
  exit 0
fi

[ -f "$LOCK" ] || { echo "ERROR: $LOCK missing — run with --write first" >&2; exit 1; }
fail=0

# Direction 1: every manifest dep is locked.
while IFS=$'\t' read -r url tag; do
  key="${url}@${tag}"
  locked="$(node -pe "(require('$LOCK'))[$(node -pe "JSON.stringify('$key')")] ?? ''")"
  if [ -z "$locked" ]; then
    echo "UNLOCKED: $key has no entry in nargo-deps.lock.json (run --write and review the diff)" >&2
    fail=1
    continue
  fi
  # Direction 2: the locked ref still resolves to the same commit.
  sha="$(resolve "$url" "$tag")" || { echo "UNRESOLVABLE: $key" >&2; fail=1; continue; }
  if [ "$sha" != "$locked" ]; then
    echo "MOVED REF: $key resolves to $sha but lock says $locked" >&2
    fail=1
  else
    echo "ok: $key -> $sha"
  fi
done < <(manifest_pairs)

# Direction 2b: no stale lock entries for deps that left the manifests (advisory tidy signal).
while IFS= read -r key; do
  if ! manifest_pairs | awk -F'\t' '{print $1"@"$2}' | grep -qxF "$key"; then
    echo "STALE LOCK ENTRY (not fatal): $key no longer appears in any Nargo.toml" >&2
  fi
done < <(node -pe "Object.keys(require('$LOCK')).join('\n')")

exit "$fail"
