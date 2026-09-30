// bun test scripts/lib/nargo-deps.test.mjs — bun is the runtime verify-nargo-refs.sh uses (Bun.TOML).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { parseNargoDeps, rawManifestUrl, resolveRelative } from './nargo-deps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'a'.repeat(40);
const deps = (body) => parseNargoDeps(`[dependencies]\n${body}`);

function repoManifests(dir = join(ROOT, 'packages'), acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'target' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) repoManifests(p, acc);
    else if (e === 'Nargo.toml') acc.push(p);
  }
  return acc;
}

test("every Nargo.toml in this repo parses, and the contracts' aztec-nr deps are found", () => {
  const files = repoManifests();
  const git = files.flatMap((f) => parseNargoDeps(readFileSync(f, 'utf8')).git);
  // One aztec dep per contract/lib crate (private_contract, fpc_lib, quota_fpc, fpc_test_target).
  assert.ok(git.filter((d) => /(^|\/)aztec$/.test(d.dir)).length >= 4, JSON.stringify(git));
});

test('upstream aztec-nr shapes: field order, optional directory, path deps', () => {
  const aztec = parseNargoDeps(`[dependencies]
protocol_types = { git = "https://github.com/AztecProtocol/aztec-packages", tag = "v6.0.0-rc.1", directory = "noir-projects/fnd/noir-protocol-circuits/crates/types" }
sha256 = { tag = "v0.3.0", git = "https://github.com/noir-lang/sha256" }`);
  assert.deepEqual(aztec.git, [
    {
      url: 'https://github.com/AztecProtocol/aztec-packages',
      tag: 'v6.0.0-rc.1',
      dir: 'noir-projects/fnd/noir-protocol-circuits/crates/types',
    },
    { url: 'https://github.com/noir-lang/sha256', tag: 'v0.3.0', dir: '.' },
  ]);
  const balanceSet = deps('aztec = { path = "../aztec" }\nuint_note = { path = "../uint-note" }');
  assert.deepEqual(balanceSet, { git: [], paths: ['../aztec', '../uint-note'] });
  assert.equal(resolveRelative('balance-set', '../aztec'), 'aztec');
});

test('hostile or unsupported dependency lines fail closed', () => {
  const hostile = [
    'x = { git = "https://github.com/a/b", tag = "v1\\"; touch /tmp/pwned; \\"" }', // quote in the tag
    'x = { git = "https://github.com/a/b", tag = "v1", directory = "../../etc" }', // .. in the directory
    'x = { git = "https://evil.example/a/b", tag = "v1" }', // non-GitHub host
    'x = { git = "https://github.com/a/b", branch = "main" }', // branch dep
    'x = { git = "https://github.com/a/b", tag = "v1", rev = "abc" }', // rev alongside a tag
    'x = { git = "https://github.com/a/b", tag = "v1", extra = "?" }', // unknown key
    'x = "0.1.0"', // a registry-style version string
    '[dev-dependencies]\nx = { git = "https://github.com/a/b", tag = "v1" }', // git key outside [dependencies]
    'x = { git = "https://github.com/a/b",', // truncated inline table: invalid TOML
  ];
  for (const line of hostile) {
    assert.throws(() => deps(line), /unsupported Nargo dependency|unparseable Nargo.toml/, line);
  }
});

test('escaped or quoted keys are read the way nargo reads them', () => {
  // A line regex missed both: the escaped key hid a git dep, the quoted key hid a directory.
  assert.deepEqual(deps('x = { "g\\u0069t" = "https://github.com/a/b", tag = "v1" }').git, [
    { url: 'https://github.com/a/b', tag: 'v1', dir: '.' },
  ]);
  assert.deepEqual(deps('x = { git = "https://github.com/a/b", tag = "v1", "directory" = "hidden" }').git, [
    { url: 'https://github.com/a/b', tag: 'v1', dir: 'hidden' },
  ]);
});

test('paths and URLs cannot leave the pinned repository', () => {
  assert.throws(() => resolveRelative('aztec', '../../outside'), /escapes the repository/);
  assert.equal(
    rawManifestUrl('https://github.com/aztec-labs-eng/aztec-nr', SHA, 'aztec'),
    `https://raw.githubusercontent.com/aztec-labs-eng/aztec-nr/${SHA}/aztec/Nargo.toml`,
  );
  assert.throws(() => rawManifestUrl('https://github.com/a/b', 'v1', 'aztec'), /refusing/);
});
