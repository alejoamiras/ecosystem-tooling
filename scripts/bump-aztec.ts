#!/usr/bin/env bun
/**
 * Lockstep Aztec version bump.
 *
 * Sweeps EVERY location the Aztec version lives, validating the whole result before writing
 * any of it:
 *   - root package.json  config.aztecVersion
 *   - packages/*'/package.json  version (lockstep) + every @aztec-labs/* and @aztec-foundation/*
 *     pin (direct or aliased) + internal cross-package pins (deps whose name is itself a
 *     workspace package — detected by name set, not prefix). Legacy @aztec/* names are an
 *     error (scripts/lib/manifest-policy.ts); the only legacy name left is the viem alias.
 *   - packages/*'/**'/Nargo.toml  `tag = "v<old>"` on aztec-nr lines (noir-lang deps untouched;
 *     a legacy aztec-nr URL is an error)
 *   - every package's PRD header `**Target Aztec Version**`
 *
 * Min-age handling (bun's minimumReleaseAgeExcludes takes exact names, and transitives are
 * gated independently): only names whose resolved version is younger than 7 days are exempted.
 *   - pre-install: walk the registry closure at the TARGET and write its young names
 *   - post-install (--regenerate-excludes): recompute from the fresh bun.lock, then print the
 *     supply-chain report (publish date, age, publisher, attestation presence) for the PR
 *
 * Usage:
 *   bun scripts/bump-aztec.ts 6.0.0-rc.1
 *   bun scripts/bump-aztec.ts --regenerate-excludes
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  closureEdge,
  EXACT_SEMVER,
  isLockstepName,
  lockfilePairs,
  type PublishRow,
  parseAlias,
  sweepNargoLine,
  youngNames,
} from './lib/aztec-scopes.ts';
import { DEP_SECTIONS, type Manifest, validateManifest } from './lib/manifest-policy.ts';

const ROOT = join(import.meta.dir, '..');
const PACKAGES = readdirSync(join(ROOT, 'packages')).filter((d) => statSync(join(ROOT, 'packages', d)).isDirectory());
const manifestPath = (dir: string) => join(ROOT, 'packages', dir, 'package.json');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
// Workspace package NAMES. Internal cross-package pins are bumped by membership in this set —
// NOT a name prefix — so a package rename can't silently drop a pin from the sweep.
const WORKSPACE_NAMES = new Set<string>(PACKAGES.map((d) => readJson(manifestPath(d)).name));

interface RegistryDoc {
  version?: string;
  time?: Record<string, string>;
  dependencies?: Record<string, string>;
  dist?: { attestations?: { url?: string } | null };
  _npmUser?: string;
}

const docs = new Map<string, RegistryDoc>();
/** The registry's view of one exact version. Every failure throws: no caller may read "unfetchable" as "absent". */
function registryDoc(spec: string): RegistryDoc {
  const cached = docs.get(spec);
  if (cached) return cached;
  let out: string;
  try {
    out = execFileSync('npm', ['view', spec, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim().split('\n')[0];
    throw new Error(`npm view ${spec} failed: ${stderr || e}`);
  }
  const doc = out ? JSON.parse(out) : undefined;
  if (!doc || Array.isArray(doc)) throw new Error(`npm view ${spec}: expected exactly one published version`);
  docs.set(spec, doc);
  return doc;
}

const publishRow = (name: string, version: string): PublishRow => ({
  name,
  version,
  publishedAt: registryDoc(`${name}@${version}`).time?.[version],
});

function writeExcludes(names: string[], source: string): void {
  const bunfigPath = join(ROOT, 'bunfig.toml');
  const line = `minimumReleaseAgeExcludes = [${names.map((n) => `"${n}"`).join(', ')}]`;
  const re = /^#?\s*minimumReleaseAgeExcludes\s*=.*$/m;
  const bunfig = readFileSync(bunfigPath, 'utf8');
  writeFileSync(bunfigPath, re.test(bunfig) ? bunfig.replace(re, line) : `${bunfig.trimEnd()}\n${line}\n`);
  console.log(
    `bunfig.toml: ${names.length} min-age exclusion(s) written (${source})${names.length ? `: ${names.join(', ')}` : ''}`,
  );
}

function fail(errors: string[]): never {
  console.error(`bump-aztec: refusing — nothing was written:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}

if (process.argv[2] === '--regenerate-excludes') {
  const now = Date.now();
  const rows = [...lockfilePairs(readFileSync(join(ROOT, 'bun.lock'), 'utf8'))].flatMap(([name, versions]) =>
    versions.map((v) => publishRow(name, v)),
  );
  writeExcludes(youngNames(rows, now), 'from bun.lock');

  console.log('\n=== supply-chain report (from bun.lock) ===\n');
  console.log('| package | version | published (UTC) | age (days) | publisher | attestation present (not verified) |');
  console.log('|---|---|---|---|---|---|');
  const unattested: string[] = [];
  for (const row of rows) {
    const doc = registryDoc(`${row.name}@${row.version}`);
    const attested = Boolean(doc.dist?.attestations?.url);
    // The foundation scope ships attestations today; a missing one is a tripwire, not a proof.
    if (row.name.startsWith('@aztec-foundation/') && !attested) unattested.push(`${row.name}@${row.version}`);
    const age = ((now - Date.parse(row.publishedAt as string)) / 86_400_000).toFixed(1);
    const publisher = (doc._npmUser ?? 'unknown').replace(/\s*<.*$/, '');
    console.log(
      `| ${row.name} | ${row.version} | ${row.publishedAt} | ${age} | ${publisher} | ${attested ? 'yes' : 'no'} |`,
    );
  }
  if (unattested.length > 0) {
    console.error(`\n@aztec-foundation/* without attestations (expected present): ${unattested.join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

const target = process.argv[2];
if (!target || !EXACT_SEMVER.test(target)) {
  console.error(
    'usage: bun scripts/bump-aztec.ts <version>   (e.g. 6.0.0-rc.1)\n       bun scripts/bump-aztec.ts --regenerate-excludes',
  );
  process.exit(1);
}

// Refuse to sweep to a version that isn't actually on the registry.
if (registryDoc(`@aztec-labs/aztec.js@${target}`).version !== target) {
  fail([`@aztec-labs/aztec.js@${target} is not on the npm registry`]);
}

const errors: string[] = [];
const writes: Array<[path: string, content: string]> = [];
const edits: string[] = [];

// 1. Root config.aztecVersion
{
  const p = join(ROOT, 'package.json');
  const pkg = readJson(p);
  edits.push(`root config.aztecVersion: ${pkg.config?.aztecVersion} -> ${target}`);
  pkg.config = { ...pkg.config, aztecVersion: target };
  writes.push([p, `${JSON.stringify(pkg, null, 2)}\n`]);
}

// 2. Package manifests: lockstep version + Aztec pins + internal pins
const swept: Array<[dir: string, pkg: Manifest]> = [];
for (const dir of PACKAGES) {
  const pkg = readJson(manifestPath(dir));
  const old = pkg.version;
  pkg.version = target;
  let count = 0;
  for (const section of DEP_SECTIONS) {
    const deps: Record<string, string> | undefined = pkg[section];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      const alias = parseAlias(spec);
      if ((isLockstepName(name) && EXACT_SEMVER.test(spec)) || WORKSPACE_NAMES.has(name)) {
        deps[name] = target;
        count++;
      } else if (alias && isLockstepName(alias.target)) {
        deps[name] = `npm:${alias.target}@${target}`;
        count++;
      }
    }
  }
  errors.push(...validateManifest(pkg, { aztecVersion: target }).map((e) => `packages/${dir}: ${e}`));
  swept.push([dir, pkg]);
  writes.push([manifestPath(dir), `${JSON.stringify(pkg, null, 2)}\n`]);
  edits.push(`packages/${dir}: version ${old} -> ${target}, ${count} pins`);
}

// 3. Nargo.toml aztec-nr tags
function walkNargoTomls(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'target' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkNargoTomls(p, acc);
    else if (entry === 'Nargo.toml') acc.push(p);
  }
  return acc;
}
for (const tomlPath of walkNargoTomls(join(ROOT, 'packages'))) {
  const rel = tomlPath.replace(`${ROOT}/`, '');
  const before = readFileSync(tomlPath, 'utf8');
  const after = before
    .split('\n')
    .map((line) => {
      const r = sweepNargoLine(line, target);
      if (r.error) errors.push(`${rel}: ${r.error}`);
      return r.line;
    })
    .join('\n');
  if (after !== before) {
    writes.push([tomlPath, after]);
    edits.push(`${rel}: aztec-nr tag -> v${target}`);
  }
}

// 4. PRD headers — every package's product-requirements doc, discovered by glob.
for (const pkg of PACKAGES) {
  const docsDir = join(ROOT, 'packages', pkg, 'docs');
  let prds: string[] = [];
  try {
    prds = readdirSync(docsDir).filter((f) => f.endsWith('product-requirements.md'));
  } catch {
    continue; // no docs dir — nothing to sweep
  }
  for (const doc of prds) {
    const prd = join(docsDir, doc);
    const before = readFileSync(prd, 'utf8');
    const after = before.replace(/(\*\*Target Aztec Version\*\*:\s*)\S+/, `$1${target}`);
    if (after !== before) {
      writes.push([prd, after]);
      edits.push(`${pkg} PRD Target Aztec Version updated`);
    }
  }
}

if (errors.length > 0) fail(errors);

// 5. Min-age exclusions from the registry closure of the swept manifests. A lockstep dep off
// the target means labs and foundation diverged — stop rather than guess a second version.
const closure = new Map<string, string>();
const queue: Array<[name: string, version: string]> = [];
for (const [dir, pkg] of swept) {
  for (const section of DEP_SECTIONS) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      const edge = closureEdge(`packages/${dir}`, name, spec, target);
      if (edge && 'error' in edge) errors.push(edge.error);
      else if (edge) queue.push([edge.name, edge.version]);
    }
  }
}
while (queue.length > 0) {
  const [name, version] = queue.shift() as [string, string];
  if (closure.has(name)) continue;
  closure.set(name, version);
  for (const [dep, spec] of Object.entries(registryDoc(`${name}@${version}`).dependencies ?? {})) {
    const edge = closureEdge(`${name}@${version}`, dep, spec, target);
    if (edge && 'error' in edge) errors.push(edge.error);
    else if (edge && !closure.has(edge.name)) queue.push([edge.name, edge.version]);
  }
}
if (errors.length > 0) fail(errors);
const young = youngNames(
  [...closure].map(([n, v]) => publishRow(n, v)),
  Date.now(),
);

for (const [p, content] of writes) writeFileSync(p, content);
writeExcludes(young, `registry closure of ${closure.size} packages (pre-install)`);

console.log(`\n=== bump-aztec: swept to ${target} ===`);
for (const e of edits) console.log(`  - ${e}`);
console.log(
  '\nNext: scripts/verify-nargo-refs.sh --write && bun install && bun scripts/bump-aztec.ts --regenerate-excludes (prints the supply-chain report) && bun install --frozen-lockfile',
);
