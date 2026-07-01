#!/usr/bin/env bun
/**
 * Lockstep Aztec version bump (plan D9/D14/Phase 6).
 *
 * Sweeps EVERY location the Aztec version lives:
 *   - root package.json  config.aztecVersion
 *   - packages/*'/package.json  version (lockstep) + every @aztec/* pin in
 *     dependencies/devDependencies/peerDependencies + internal @alejoamiras/aztec-* pins
 *   - packages/*'/**'/Nargo.toml  `tag = "v<old>"` on lines referencing aztec-packages
 *     (noir-lang deps like keccak256/sha512/bignum are deliberately untouched)
 *   - fee-payment PRD header `**Target Aztec Version**`
 *
 * Min-age handling (two-phase — bun's minimumReleaseAgeExcludes takes exact names and
 * transitives are gated independently; empirically verified, lessons/phase-1.md):
 *   - pre-install: BFS the @aztec/* dependency closure from the npm registry at the
 *     TARGET version and write it into bunfig.toml when the target is <7 days old
 *   - post-install (--regenerate-excludes): rewrite the list from the fresh bun.lock
 *
 * Also emits a supply-chain report (publish date, age, provenance) for the bump PR.
 *
 * Usage:
 *   bun scripts/bump-aztec.ts 5.0.0-rc.2
 *   bun scripts/bump-aztec.ts --regenerate-excludes
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PACKAGES = readdirSync(join(ROOT, 'packages')).filter((d) => statSync(join(ROOT, 'packages', d)).isDirectory());

const npmView = (spec: string, field: string): unknown => {
  try {
    const out = execFileSync('npm', ['view', spec, field, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out ? JSON.parse(out) : undefined;
  } catch {
    return undefined;
  }
};

function walkNargoTomls(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'target' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkNargoTomls(p, acc);
    else if (entry === 'Nargo.toml') acc.push(p);
  }
  return acc;
}

function aztecClosure(version: string): string[] {
  const seen = new Set<string>();
  const queue = ['@aztec/aztec.js', '@aztec/wallets', '@aztec/pxe', '@aztec/accounts', '@aztec/ethereum'];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const deps = (npmView(`${name}@${version}`, 'dependencies') ?? {}) as Record<string, string>;
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith('@aztec/') && !seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen].sort();
}

function lockfileAztecNames(): string[] {
  const lock = readFileSync(join(ROOT, 'bun.lock'), 'utf8');
  const names = new Set<string>();
  for (const m of lock.matchAll(/"(@aztec\/[a-z0-9._-]+)@/gi)) names.add(m[1]);
  return [...names].sort();
}

function writeExcludes(names: string[], source: string): void {
  const bunfigPath = join(ROOT, 'bunfig.toml');
  let bunfig = readFileSync(bunfigPath, 'utf8');
  const line = `minimumReleaseAgeExcludes = [${names.map((n) => `"${n}"`).join(', ')}]`;
  if (/^#?\s*minimumReleaseAgeExcludes\s*=.*$/m.test(bunfig)) {
    bunfig = bunfig.replace(/^#?\s*minimumReleaseAgeExcludes\s*=.*$/m, line);
  } else {
    bunfig = `${bunfig.trimEnd()}\n${line}\n`;
  }
  writeFileSync(bunfigPath, bunfig);
  console.log(`bunfig.toml: ${names.length} @aztec/* exclusions written (${source})`);
}

if (process.argv[2] === '--regenerate-excludes') {
  writeExcludes(lockfileAztecNames(), 'from bun.lock');
  process.exit(0);
}

const target = process.argv[2];
if (!target || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/.test(target)) {
  console.error(
    'usage: bun scripts/bump-aztec.ts <version>   (e.g. 5.0.0-rc.2)\n       bun scripts/bump-aztec.ts --regenerate-excludes',
  );
  process.exit(1);
}

// Refuse to sweep to a version that isn't actually on the registry.
const published = npmView(`@aztec/aztec.js@${target}`, 'version');
if (published !== target) {
  console.error(`@aztec/aztec.js@${target} is not on the npm registry — aborting`);
  process.exit(1);
}

const edits: string[] = [];

// 1. Root config.aztecVersion
{
  const p = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  const old = pkg.config?.aztecVersion;
  pkg.config = { ...pkg.config, aztecVersion: target };
  writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
  edits.push(`root config.aztecVersion: ${old} -> ${target}`);
}

// 2. Package manifests: lockstep version + @aztec/* + internal pins
for (const dir of PACKAGES) {
  const p = join(ROOT, 'packages', dir, 'package.json');
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  const old = pkg.version;
  pkg.version = target;
  let count = 0;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith('@aztec/') && /^\d+\.\d+\.\d+(-|$)/.test(deps[name])) {
        deps[name] = target;
        count++;
      }
      if (name.startsWith('@alejoamiras/aztec-')) {
        deps[name] = target;
        count++;
      }
    }
  }
  writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
  edits.push(`packages/${dir}: version ${old} -> ${target}, ${count} dep pins`);
}

// 3. Nargo.toml git tags (aztec-packages refs only)
for (const tomlPath of walkNargoTomls(join(ROOT, 'packages'))) {
  const before = readFileSync(tomlPath, 'utf8');
  const after = before
    .split('\n')
    .map((line) =>
      line.includes('aztec-packages') ? line.replace(/tag\s*=\s*"v[0-9][^"]*"/, `tag = "v${target}"`) : line,
    )
    .join('\n');
  if (after !== before) {
    writeFileSync(tomlPath, after);
    edits.push(`${tomlPath.replace(`${ROOT}/`, '')}: aztec tag -> v${target}`);
  }
}

// 4. Fee-payment PRD header
{
  const prd = join(ROOT, 'packages/aztec-fee-payment/docs/private-product-requirements.md');
  try {
    const before = readFileSync(prd, 'utf8');
    const after = before.replace(/(\*\*Target Aztec Version\*\*:\s*)\S+/, `$1${target}`);
    if (after !== before) {
      writeFileSync(prd, after);
      edits.push('fee-payment PRD Target Aztec Version updated');
    }
  } catch {
    /* PRD moved — surface via missing edit line */
  }
}

console.log(`\n=== bump-aztec: swept to ${target} ===`);
for (const e of edits) console.log(`  - ${e}`);

// 5. Min-age exclusions (pre-install closure) — only needed when the target is young.
const times = (npmView(`@aztec/aztec.js@${target}`, 'time') ?? {}) as Record<string, string>;
const publishedAt = times[target] ? new Date(times[target]) : undefined;
const ageMs = publishedAt ? Date.now() - publishedAt.getTime() : Number.NaN;
const needsExcludes = Number.isFinite(ageMs) && ageMs < MIN_AGE_MS;
let closure: string[] = [];
if (needsExcludes) {
  console.log(
    `\n@aztec/*@${target} is ${(ageMs / 86_400_000).toFixed(1)} days old (<7d) — computing registry closure...`,
  );
  closure = aztecClosure(target);
  writeExcludes(closure, 'registry closure (pre-install)');
} else {
  console.log(`\n@aztec/*@${target} clears the 7-day min-age gate — no exclusions needed.`);
}

// 6. Supply-chain report (markdown, for the bump PR description)
console.log('\n=== supply-chain report ===\n');
console.log(`| package | version | published (UTC) | age (days) | provenance |`);
console.log(`|---|---|---|---|---|`);
const reportSet = closure.length > 0 ? closure : lockfileAztecNames();
for (const name of reportSet) {
  const t = (npmView(`${name}@${target}`, 'time') ?? {}) as Record<string, string>;
  const at = t[target];
  const age = at ? ((Date.now() - new Date(at).getTime()) / 86_400_000).toFixed(1) : 'n/a';
  const att = npmView(`${name}@${target}`, 'dist.attestations.url');
  console.log(`| ${name} | ${target} | ${at ?? 'NOT PUBLISHED'} | ${age} | ${att ? 'yes' : 'NO'} |`);
}

console.log(
  '\nNext: bun install && bun scripts/bump-aztec.ts --regenerate-excludes && full validation (plan Phase 6).',
);
