#!/usr/bin/env bash
# Installs the Aztec toolchain for <version> into AZTEC_HOME (default ~/.aztec) from inputs
# pinned by sha256 in aztec-toolchain.lock.json (AZTEC_TOOLCHAIN_LOCK overrides the path).
#
# Upstream's per-version `install` is verified, then sourced for its step functions; its `main`
# never runs, because it sources nvm unconditionally. The steps that would fetch floating
# installers (versions manifest, node, noirup, foundryup) are replaced with verified files, and
# curl/wget are stubbed on PATH while upstream code runs. The known unpinned path left is the
# lockfile-less `npm install` inside install_aztec_packages.
#
# Usage: scripts/install-aztec-toolchain.sh <version> [AZTEC_HOME]
# shellcheck disable=SC2154 # version_path and friends are assigned by the sourced upstream script
set -euo pipefail

version="${1:?usage: install-aztec-toolchain.sh <version> [AZTEC_HOME]}"
aztec_home="${2:-${AZTEC_HOME:-$HOME/.aztec}}"
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
lock="${AZTEC_TOOLCHAIN_LOCK:-$root/aztec-toolchain.lock.json}"

fail() {
  echo "install-aztec-toolchain: $*" >&2
  exit 1
}

[[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] || fail "invalid version: $version"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x64 ;;
  *) fail "no pinned toolchain assets for $(uname -s)-$(uname -m)" ;;
esac

# shellcheck disable=SC2016 # JS template literals, not shell expansions
entries="$(node -e '
const [lockPath, version, platform] = process.argv.slice(1);
const e = JSON.parse(require("node:fs").readFileSync(lockPath, "utf8"))[version];
if (!e) throw new Error(`no ${version} entry in ${lockPath}`);
const pins = { install: e.install, versions: e.versions, "nargo.tar.gz": e.nargo?.[platform], "foundry.tar.gz": e.foundry?.[platform] };
for (const [name, p] of Object.entries(pins)) {
  if (!/^https:\/\/\S+$/.test(p?.url) || !/^[0-9a-f]{64}$/.test(p?.sha256)) throw new Error(`malformed ${name} pin for ${version} ${platform}`);
  console.log(`${name}\t${p.url}\t${p.sha256}`);
}' "$lock" "$version" "$platform")"

mkdir -p "$aztec_home"
aztec_home="$(cd -- "$aztec_home" && pwd)"
work="$(mktemp -d "$aztec_home/.install-XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Nothing below the checksum check runs on bytes that failed it.
while IFS=$'\t' read -r name url sha; do
  curl -sSfL --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$work/$name" "$url"
  printf '%s  %s\n' "$sha" "$name" >>"$work/SHA256SUMS"
done <<<"$entries"
(cd "$work" && sha256sum -c --strict SHA256SUMS)

grep -Fxq "VERSION=$version" "$work/install" || fail "pinned install script does not set VERSION=$version"

# Upstream ends with `main "$@"`, `exit`, `}` (the brace-wrapped body guards truncated pipes).
# Strip exactly those two lines; any other ending means the script changed shape.
main_call='main "$@"'
ending="$(grep -vE '^[[:space:]]*(#|$)' "$work/install" | tail -n 3 | tr '\n' '|')"
[ "$ending" = "$main_call|exit|}|" ] || fail "install script ending changed: $ending"
[ "$(grep -cFx "$main_call" "$work/install")" = 1 ] && [ "$(grep -cx 'exit' "$work/install")" = 1 ] ||
  fail "install script has more than one main call or bare exit"
grep -vFx -e "$main_call" -e 'exit' "$work/install" >"$work/install.lib"

mkdir -p "$work/noir" "$work/foundry" "$work/blocked-bin"
tar -xzf "$work/nargo.tar.gz" -C "$work/noir" ./nargo ./noir-profiler
tar -xzf "$work/foundry.tar.gz" -C "$work/foundry" forge cast anvil chisel
for tool in curl wget; do
  printf '#!/bin/sh\necho "blocked network call: %s $*" >&2\nexit 1\n' "$tool" >"$work/blocked-bin/$tool"
  chmod +x "$work/blocked-bin/$tool"
done

export AZTEC_HOME="$aztec_home"
# From here on, upstream code runs (sourcing included): a PATH-level curl/wget is a tripwire
# against an unpinned fetch, not a sandbox; absolute paths or other clients would bypass it.
PATH="$work/blocked-bin:$PATH"
# shellcheck source=/dev/null
source "$work/install.lib"

steps=(install_versions_file install_node install_noir install_foundry
  install_native_symlinks install_aztec_packages install_npm_bin_symlinks install_aztec_wrapper)
upstream_steps="$(declare -f main | grep -oE '\binstall_[a-z_]+' | tr '\n' ' ')"
[ "$upstream_steps" = "${steps[*]} " ] || fail "upstream main runs a different step list: $upstream_steps"

# Overrides, defined after the source so they replace upstream's.
install_versions_file() { cp "$work/versions" "$version_path/versions"; }

install_node() {
  local min installed
  min="$(get_version node)"
  installed="$(node --version 2>/dev/null)" || installed=none
  installed="${installed#v}"
  if [ "$installed" = none ] || [ "$(printf '%s\n' "$min" "$installed" | sort -V | head -n1)" != "$min" ]; then
    fail "node >= $min required (found $installed); this installer never installs node"
  fi
}

# Upstream's install_noir copies $NARGO and the noir-profiler beside it, skipping noirup.
# shellcheck disable=SC2034
NARGO="$work/noir/nargo"

install_foundry() {
  local bin
  for bin in forge cast anvil chisel; do
    rm -f "$version_internal_bin_path/$bin"
    cp -p "$work/foundry/$bin" "$version_internal_bin_path/$bin"
  done
}

mkdir -p "$version_bin_path" "$version_internal_bin_path"
for step in "${steps[@]}"; do
  echo "==> $step"
  "$step"
done

ln -sfn "$version_path" "$aztec_home/current"
echo "installed Aztec $version into $version_path"
