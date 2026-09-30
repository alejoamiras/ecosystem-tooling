// Nargo.toml dependency parsing + nargo-deps.lock.json IO for scripts/verify-nargo-refs.sh.
//
// Everything the shell script needs from a manifest or the lock goes through this file, with
// values passed as argv and printed as validated TSV — never interpolated into code. Remote
// manifests are attacker-reachable input (anyone who can move an upstream tag can shape them),
// so every field is checked against a strict charset before the shell sees it.
//
// Discovery is deliberately broader than acceptance: any line that mentions a git/path key is
// examined, and anything not in the one supported shape is an error rather than a skip — a
// dependency the parser cannot read is a dependency the lock cannot pin.

import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

export const URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const TAG_RE = /^[A-Za-z0-9._-]+$/;
export const SHA_RE = /^[0-9a-f]{40}$/;
const DIR_RE = /^[A-Za-z0-9._/-]+$/;
const DISCOVERY_RE = /["']?\b(git|path)\b["']?\s*=/;
/** Repo root, as a directory value. */
export const ROOT_DIR = '.';

/** A repo-relative directory: charset-checked, no absolute path, no `..` or empty segment. */
export function validDir(dir) {
  if (dir === ROOT_DIR) return true;
  if (!DIR_RE.test(dir) || dir.startsWith('/') || dir.endsWith('/')) return false;
  return dir.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Resolves a path dependency against its manifest's directory, refusing to leave the repo. */
export function resolveRelative(dir, rel) {
  if (!/^[A-Za-z0-9._/-]+$/.test(rel) || rel.startsWith('/')) throw new Error(`invalid path dependency: ${rel}`);
  const joined = posix.normalize(posix.join(dir === ROOT_DIR ? '' : dir, rel)).replace(/\/+$/, '');
  const out = joined === '' || joined === '.' ? ROOT_DIR : joined;
  if (!validDir(out)) throw new Error(`path dependency ${rel} from ${dir} escapes the repository`);
  return out;
}

const field = (line, key) => new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(line)?.[1];

/**
 * @param {string} text Nargo.toml contents
 * @returns {{ git: Array<{url: string, tag: string, dir: string}>, paths: string[] }}
 * @throws listing every dependency line outside the supported single-line shapes
 */
export function parseNargoDeps(text) {
  const git = [];
  const paths = [];
  const bad = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!DISCOVERY_RE.test(line)) continue;
    const url = field(line, 'git')?.replace(/\/+$/, '');
    const tag = field(line, 'tag');
    const dir = field(line, 'directory') ?? ROOT_DIR;
    const path = field(line, 'path');
    const pinnedElsewhere = /\b(branch|rev)\s*=/.test(line);
    if (url !== undefined && path === undefined && !pinnedElsewhere) {
      if (URL_RE.test(url) && tag !== undefined && TAG_RE.test(tag) && validDir(dir)) {
        git.push({ url, tag, dir });
        continue;
      }
    } else if (path !== undefined && url === undefined && tag === undefined && !pinnedElsewhere) {
      paths.push(path);
      continue;
    }
    bad.push(line);
  }
  if (bad.length > 0) {
    throw new Error(
      'unsupported Nargo dependency form(s) — a git dep must be a single-line inline table with double-quoted ' +
        'github.com git=, tag= and optional directory=, and no branch=/rev= (anything else escapes the commit lock):\n' +
        bad.join('\n'),
    );
  }
  return { git, paths };
}

export function rawManifestUrl(url, sha, dir) {
  if (!URL_RE.test(url) || !SHA_RE.test(sha) || !validDir(dir)) {
    throw new Error(`refusing to build a manifest URL from ${url} ${sha} ${dir}`);
  }
  const repo = url.slice('https://github.com/'.length);
  return `https://raw.githubusercontent.com/${repo}/${sha}/${dir === ROOT_DIR ? '' : `${dir}/`}Nargo.toml`;
}

const tsv = (deps) => [...new Set(deps.map((d) => `${d.url}\t${d.tag}\t${d.dir}`))].sort().join('\n');
const readLock = (lockPath) => JSON.parse(readFileSync(lockPath, 'utf8'));

const COMMANDS = {
  // deps <Nargo.toml>... — git deps of this repo's own manifests (its path deps are found by
  // the caller's own directory walk).
  deps: (files) => tsv(files.flatMap((f) => parseNargoDeps(readFileSync(f, 'utf8')).git)),
  // remote-deps <Nargo.toml> <url> <tag> <dir> — a fetched manifest's git deps, plus its path
  // deps resolved inside the same repo at the same tag (nargo fetches those from that checkout).
  'remote-deps': ([file, url, tag, dir]) => {
    const { git, paths } = parseNargoDeps(readFileSync(file, 'utf8'));
    return tsv([...git, ...paths.map((p) => ({ url, tag, dir: resolveRelative(dir, p) }))]);
  },
  'raw-url': ([url, sha, dir]) => rawManifestUrl(url, sha, dir),
  'lock-get': ([lockPath, key]) => readLock(lockPath)[key] ?? '',
  'lock-keys': ([lockPath]) => Object.keys(readLock(lockPath)).join('\n'),
  // lock-write <lock> <tsv of key\tsha>
  'lock-write': ([lockPath, tsvPath]) => {
    const entries = readFileSync(tsvPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'));
    for (const [key, sha] of entries) {
      if (!SHA_RE.test(sha ?? '')) throw new Error(`lock-write: ${key} has no valid sha (${sha})`);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    writeFileSync(lockPath, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
    return '';
  },
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = COMMANDS[cmd];
  if (!run) {
    console.error(`usage: nargo-deps.mjs <${Object.keys(COMMANDS).join('|')}> ...`);
    process.exit(2);
  }
  try {
    const out = run(args);
    if (out) process.stdout.write(`${out}\n`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
