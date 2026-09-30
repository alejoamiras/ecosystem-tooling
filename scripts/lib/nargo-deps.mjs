// Nargo.toml dependency parsing + nargo-deps.lock.json IO for scripts/verify-nargo-refs.sh.
//
// Everything the shell script needs from a manifest or the lock goes through this file, with
// values passed as argv and printed as validated TSV — never interpolated into code. Remote
// manifests are attacker-reachable input (anyone who can move an upstream tag can shape them),
// so every field is checked against a strict charset before the shell sees it.
//
// Manifests are parsed as TOML (Bun.TOML), never by line matching: a quoted or escaped key
// (`"g\u0069t" = ...`) is still `git` to nargo, and a regex would miss it. Every dependency must
// be one of the two supported shapes, and a git/path key anywhere outside [dependencies] is an
// error rather than a skip — a dependency the parser cannot read is one the lock cannot pin.
// Runs under bun (verify-nargo-refs.sh invokes it that way) for the TOML parser.

import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

export const URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const TAG_RE = /^[A-Za-z0-9._-]+$/;
export const SHA_RE = /^[0-9a-f]{40}$/;
const DIR_RE = /^[A-Za-z0-9._/-]+$/;
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

const DEP_KEYS = new Set(['git', 'path']);
const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every git/path key outside the top-level [dependencies] table, as dotted paths. */
function strayDependencyKeys(node, at, out) {
  if (Array.isArray(node)) node.forEach((v, i) => strayDependencyKeys(v, `${at}[${i}]`, out));
  else if (isTable(node)) {
    for (const [k, v] of Object.entries(node)) {
      const here = at ? `${at}.${k}` : k;
      if (here === 'dependencies') continue;
      if (DEP_KEYS.has(k)) out.push(here);
      strayDependencyKeys(v, here, out);
    }
  }
  return out;
}

/**
 * @param {string} text Nargo.toml contents
 * @returns {{ git: Array<{url: string, tag: string, dir: string}>, paths: string[] }}
 * @throws on invalid TOML, or listing every dependency outside the two supported shapes:
 *   `{ git, tag[, directory] }` with a github.com URL, or `{ path }`
 */
export function parseNargoDeps(text) {
  let doc;
  try {
    doc = Bun.TOML.parse(text);
  } catch (e) {
    throw new Error(`unparseable Nargo.toml: ${e.message}`);
  }
  const git = [];
  const paths = [];
  const bad = strayDependencyKeys(doc, '', []).map((k) => `${k} (outside [dependencies])`);
  const deps = doc.dependencies ?? {};
  if (!isTable(deps)) bad.push('[dependencies] is not a table');
  for (const [name, spec] of Object.entries(isTable(deps) ? deps : {})) {
    const keys = isTable(spec) ? Object.keys(spec).sort().join(',') : '';
    const str = (k) => (typeof spec[k] === 'string' ? spec[k] : undefined);
    if (keys === 'git,tag' || keys === 'directory,git,tag') {
      const url = str('git')?.replace(/\/+$/, '');
      const tag = str('tag');
      const dir = keys === 'git,tag' ? ROOT_DIR : str('directory');
      if (url && URL_RE.test(url) && tag && TAG_RE.test(tag) && dir !== undefined && validDir(dir)) {
        git.push({ url, tag, dir });
        continue;
      }
    } else if (keys === 'path' && str('path') !== undefined) {
      paths.push(spec.path);
      continue;
    }
    bad.push(`${name} = ${JSON.stringify(spec)}`);
  }
  if (bad.length > 0) {
    throw new Error(
      'unsupported Nargo dependency form(s) — a git dep must be exactly { git, tag[, directory] } on a ' +
        'github.com URL (no branch/rev: anything else escapes the commit lock), a path dep exactly { path }:\n' +
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
