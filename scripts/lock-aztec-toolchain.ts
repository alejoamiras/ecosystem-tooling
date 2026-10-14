#!/usr/bin/env bun
/**
 * Writes the aztec-toolchain.lock.json entry that scripts/install-aztec-toolchain.sh installs from.
 *
 * Hashes the upstream per-version `install` script and `versions` manifest, then pins the
 * linux-x64 noir and foundry release tarballs those versions name. Each tarball's sha256 must
 * equal the GitHub release `digest`: that proves the API and the download agree, not that the
 * asset is authentic — the reviewed lock diff carries that trust.
 *
 * Usage: bun scripts/lock-aztec-toolchain.ts 6.0.0-rc.3
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_PATH = join(import.meta.dir, '..', 'aztec-toolchain.lock.json');
const INSTALL_BASE = 'https://install.aztec-labs.com';
// Same charset the setup-aztec action accepts for config.aztecVersion; these strings end up in URLs.
const VERSION_TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

export interface Pinned {
  url: string;
  sha256: string;
}
export interface LockEntry {
  install: Pinned;
  versions: Pinned;
  nargo: { 'linux-x64': Pinned };
  foundry: { 'linux-x64': Pinned };
}
export interface ToolVersions {
  noir: string;
  foundry: string;
  node: string;
}
interface ReleaseAsset {
  name?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
}

/** Parses upstream's `versions` manifest (`<tool>: <version>` lines); any other shape is an error. */
export function parseVersions(text: string): ToolVersions {
  const seen = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const m = line.match(/^([a-z]+): (\S+)$/);
    if (!m) throw new Error(`versions: malformed line ${JSON.stringify(line)}`);
    const [, tool, version] = m;
    if (seen.has(tool)) throw new Error(`versions: duplicate ${tool}`);
    if (!VERSION_TOKEN.test(version)) throw new Error(`versions: invalid ${tool} version ${JSON.stringify(version)}`);
    seen.set(tool, version);
  }
  const get = (tool: string) => {
    const v = seen.get(tool);
    if (!v) throw new Error(`versions: no ${tool} entry`);
    return v;
  };
  return { noir: get('noir'), foundry: get('foundry'), node: get('node') };
}

/** Picks exactly one asset by name from a release, requiring its URL to be the canonical one and a sha256 digest. */
export function selectAsset(assets: ReleaseAsset[], repo: string, tag: string, name: string): Pinned {
  const matches = assets.filter((a) => a.name === name);
  if (matches.length !== 1) throw new Error(`${repo}@${tag}: expected one asset ${name}, found ${matches.length}`);
  const [asset] = matches;
  const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
  if (asset.browser_download_url !== url) {
    throw new Error(`${repo}@${tag}: ${name} download URL ${String(asset.browser_download_url)} is not ${url}`);
  }
  const digest = typeof asset.digest === 'string' ? asset.digest.match(/^sha256:([0-9a-f]{64})$/) : null;
  if (!digest) throw new Error(`${repo}@${tag}: ${name} has no sha256 digest (got ${String(asset.digest)})`);
  return { url, sha256: digest[1] };
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function pin(url: string): Promise<{ pinned: Pinned; bytes: Buffer }> {
  const bytes = await download(url);
  return { pinned: { url, sha256: sha256(bytes) }, bytes };
}

async function pinReleaseAsset(repo: string, tag: string, name: string): Promise<Pinned> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub release ${repo}@${tag}: HTTP ${res.status}`);
  const release = (await res.json()) as { assets?: ReleaseAsset[] };
  const asset = selectAsset(release.assets ?? [], repo, tag, name);
  const actual = sha256(await download(asset.url));
  if (actual !== asset.sha256)
    throw new Error(`${name}: downloaded sha256 ${actual} != release digest ${asset.sha256}`);
  return asset;
}

async function main() {
  const version = process.argv[2];
  if (!version || !VERSION_TOKEN.test(version)) {
    console.error('usage: bun scripts/lock-aztec-toolchain.ts <aztec-version>');
    process.exit(1);
  }
  const install = await pin(`${INSTALL_BASE}/${version}/install`);
  if (!install.bytes.toString('utf8').split('\n').includes(`VERSION=${version}`)) {
    throw new Error(`install script does not set VERSION=${version}`);
  }
  const versions = await pin(`${INSTALL_BASE}/${version}/versions`);
  const tools = parseVersions(versions.bytes.toString('utf8'));
  const entry: LockEntry = {
    install: install.pinned,
    versions: versions.pinned,
    nargo: {
      'linux-x64': await pinReleaseAsset('noir-lang/noir', `v${tools.noir}`, 'noir-x86_64-unknown-linux-gnu.tar.gz'),
    },
    foundry: {
      'linux-x64': await pinReleaseAsset(
        'foundry-rs/foundry',
        `v${tools.foundry}`,
        `foundry_v${tools.foundry}_linux_amd64.tar.gz`,
      ),
    },
  };
  const lock: Record<string, LockEntry> = existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, 'utf8')) : {};
  lock[version] = entry;
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(
    `aztec-toolchain.lock.json: pinned ${version} (noir ${tools.noir}, foundry ${tools.foundry}, node >= ${tools.node})`,
  );
  console.log(JSON.stringify(entry, null, 2));
}

if (import.meta.main) await main();
