#!/usr/bin/env bash
set -euo pipefail

# Nargo git deps pin MUTABLE tags (ecosystem practice) — a silently moved upstream tag
# would change the bytecode we compile and publish. This script freezes tag->commit
# identity in nargo-deps.lock.json and enforces it on every build.
#
#   scripts/verify-nargo-refs.sh --write   # (re)generate the lock from Nargo.toml manifests
#   scripts/verify-nargo-refs.sh           # verify:
#                                          #   - every reachable git dep has a lock entry
#                                          #   - every locked (url, tag) still resolves to its commit
#
# "Reachable" is TRANSITIVE: each dependency's own Nargo.toml is fetched at its pinned commit
# (verify: the LOCKED commit) and its git deps — and path deps inside that same repo — are
# walked too, since nargo re-resolves their tags at compile time just the same.
#
# Exit non-zero on any mismatch, unlocked dep, unresolvable ref, or unparseable manifest.
# All manifest parsing and lock IO lives in scripts/lib/nargo-deps.mjs (argv in, TSV out), run
# under bun for its TOML parser.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/nargo-deps.lock.json"
LIB="$ROOT/scripts/lib/nargo-deps.mjs"
MODE="${1:-verify}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

resolve() { # url tag -> commit sha; FAILS on branch/tag ambiguity
  local url="$1" tag="$2" out tag_sha head_sha
  out="$(git ls-remote "$url" "refs/tags/${tag}" "refs/tags/${tag}^{}" "refs/heads/${tag}" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  # Tag resolution: peeled (^{}) commit wins over the annotated tag object.
  tag_sha="$(printf '%s\n' "$out" | awk '$2 ~ /^refs\/tags\/.*\^\{\}$/{print $1; exit}')"
  [ -n "$tag_sha" ] || tag_sha="$(printf '%s\n' "$out" | awk '$2 ~ /^refs\/tags\//{print $1; exit}')"
  head_sha="$(printf '%s\n' "$out" | awk '$2 ~ /^refs\/heads\//{print $1; exit}')"
  # Both a branch AND a tag with this name, pointing at different commits: nargo's
  # fetch semantics vs this lock could diverge — refuse instead of guessing.
  # (ls-remote is refname-sorted, refs/heads sorts first.)
  if [ -n "$tag_sha" ] && [ -n "$head_sha" ] && [ "$tag_sha" != "$head_sha" ]; then
    echo "AMBIGUOUS REF: $url has both a tag and a branch named '$tag' at different commits (tag=$tag_sha branch=$head_sha)" >&2
    return 2
  fi
  if [ -n "$tag_sha" ]; then printf '%s\n' "$tag_sha"; else printf '%s\n' "$head_sha"; fi
}

if [ "$MODE" != "--write" ]; then
  [ -f "$LOCK" ] || { echo "ERROR: $LOCK missing — run with --write first" >&2; exit 1; }
fi

# url@tag -> sha, resolved (and in verify mode, checked against the lock) once per key.
# Runs inside $(...), so the cache lives in a file, and every log line goes to stderr.
: > "$WORK/shas.tsv"
sha_for() {
  local url="$1" tag="$2" key="$1@$2" sha locked
  sha="$(awk -F'\t' -v k="$key" '$1 == k {print $2; exit}' "$WORK/shas.tsv")"
  if [ -n "$sha" ]; then printf '%s\n' "$sha"; return 0; fi
  sha="$(resolve "$url" "$tag")" || { echo "UNRESOLVABLE: $key" >&2; return 1; }
  if [ "$MODE" = "--write" ]; then
    echo "locked: $key -> $sha" >&2
  else
    locked="$(bun "$LIB" lock-get "$LOCK" "$key")" || return 1
    if [ -z "$locked" ]; then
      echo "UNLOCKED: $key has no entry in nargo-deps.lock.json (run --write and review the diff)" >&2
      return 1
    fi
    if [ "$sha" != "$locked" ]; then
      echo "MOVED REF: $key resolves to $sha but lock says $locked" >&2
      return 1
    fi
    echo "ok: $key -> $sha" >&2
  fi
  printf '%s\t%s\n' "$key" "$sha" >> "$WORK/shas.tsv"
  printf '%s\n' "$sha"
}

# Breadth-first over (url, tag, dir). Loops read files, never process substitutions, so a
# failure anywhere below stops the script under `set -e`.
find "$ROOT/packages" -name Nargo.toml -not -path '*/node_modules/*' -not -path '*/target/*' -print0 > "$WORK/manifests"
xargs -0 bun "$LIB" deps < "$WORK/manifests" > "$WORK/frontier.tsv"
[ -s "$WORK/frontier.tsv" ] || { echo "ERROR: no git dependencies found under packages/" >&2; exit 1; }
cp "$WORK/frontier.tsv" "$WORK/seen.tsv"
fail=0
while [ -s "$WORK/frontier.tsv" ]; do
  : > "$WORK/next.tsv"
  while IFS=$'\t' read -r url tag dir; do
    if ! sha="$(sha_for "$url" "$tag")"; then
      fail=1
      continue
    fi
    raw="$(bun "$LIB" raw-url "$url" "$sha" "$dir")"
    curl --proto '=https' --tlsv1.2 -sSfL "$raw" -o "$WORK/remote.toml" ||
      { echo "ERROR: cannot fetch $raw" >&2; exit 1; }
    bun "$LIB" remote-deps "$WORK/remote.toml" "$url" "$tag" "$dir" >> "$WORK/next.tsv" ||
      { echo "ERROR: in $raw" >&2; exit 1; }
  done < "$WORK/frontier.tsv"
  sort -u "$WORK/next.tsv" > "$WORK/next.sorted"
  { grep -vxF -f "$WORK/seen.tsv" "$WORK/next.sorted" || [ $? -eq 1 ]; } > "$WORK/frontier.tsv"
  cat "$WORK/frontier.tsv" >> "$WORK/seen.tsv"
done

if [ "$MODE" = "--write" ]; then
  [ "$fail" -eq 0 ] || { echo "ERROR: unresolvable dependencies — lock NOT written" >&2; exit 1; }
  bun "$LIB" lock-write "$LOCK" "$WORK/shas.tsv"
  echo "wrote $LOCK ($(wc -l < "$WORK/shas.tsv") entries)"
  exit 0
fi

# No stale lock entries for deps that are no longer reachable (advisory tidy signal).
bun "$LIB" lock-keys "$LOCK" > "$WORK/lock-keys"
cut -f1 "$WORK/shas.tsv" > "$WORK/reached-keys"
while IFS= read -r key; do
  grep -qxF -- "$key" "$WORK/reached-keys" ||
    echo "STALE LOCK ENTRY (not fatal): $key is no longer reachable from any Nargo.toml" >&2
done < "$WORK/lock-keys"

exit "$fail"
