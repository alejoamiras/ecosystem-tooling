#!/usr/bin/env bash
set -euo pipefail

# Prints a package's dist-tags as a JSON object, read from the registry packument.
#
#   scripts/read-dist-tags.sh @alejoamiras/<pkg>            # the whole object
#   scripts/read-dist-tags.sh @alejoamiras/<pkg> <tag>      # one tag's version, '' if unset
#
# Not `npm view <pkg> dist-tags.<tag>`: that resolves the package through its `latest`
# version first, so with `latest` absent it prints nothing even when <tag> exists — and an
# empty read is exactly what a forward-only or unchanged-latest check must never mistake for
# "no tag". Any HTTP, JSON or shape failure exits non-zero.

pkg="${1:?usage: read-dist-tags.sh <@scope/name> [tag]}"
tag="${2:-}"
if ! [[ "$pkg" =~ ^@[a-z0-9-]+/[a-z0-9._-]+$ ]]; then
  echo "read-dist-tags: refusing package name '$pkg'" >&2
  exit 1
fi
if [ -n "$tag" ] && ! [[ "$tag" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "read-dist-tags: refusing tag name '$tag'" >&2
  exit 1
fi

registry="${NPM_REGISTRY:-https://registry.npmjs.org}"
doc="$(curl --proto '=https' --tlsv1.2 -sSfL \
  -H 'Accept: application/vnd.npm.install-v1+json' \
  "$registry/${pkg/\//%2F}")"

printf '%s' "$doc" | node -e '
const [tag] = process.argv.slice(1);
let doc;
try {
  doc = JSON.parse(require("fs").readFileSync(0, "utf8"));
} catch {
  console.error("read-dist-tags: registry response is not JSON");
  process.exit(1);
}
const tags = doc["dist-tags"];
if (tags === null || typeof tags !== "object" || Array.isArray(tags)) {
  console.error("read-dist-tags: no dist-tags object in the packument");
  process.exit(1);
}
process.stdout.write(tag ? String(tags[tag] ?? "") : JSON.stringify(tags));
' "$tag"
