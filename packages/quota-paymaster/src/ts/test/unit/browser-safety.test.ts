/**
 * Browser-safety probes for the published root export.
 *
 * 1. Static: no import of a node built-in, in any form, anywhere under src/ts
 *    outside operator/, test/ and cli/.
 * 2. Behavioral: `bun build --target browser` bundles the root entrypoint
 *    without error. Bun stubs node built-ins, so this cannot stand in for 1.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const srcRoot = fileURLToPath(new URL('../..', import.meta.url));
// operator/ and cli/ read files, spawn readline and load the config module; test/ never ships.
// Matched by name as top-level directories of the scanned root, so neither the checkout path nor a
// sibling such as client/ can trigger a skip.
const NODE_ONLY = ['operator', 'test', 'cli'];

function tsFilesUnder(root: string, skip: string[], dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (skip.includes(relative(root, full))) continue;
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(root, skip, full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

// TypeScript's scanner reads static, side-effect and literal dynamic imports, and require() (its third
// argument), and skips comments and strings. builtinModules names most built-ins without the node: prefix.
function nodeImportsOf(source: string): string[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map(({ fileName }) => fileName)
    .filter((spec) => spec.startsWith('node:') || builtinModules.includes(spec));
}

describe('browser safety', () => {
  test('no node-only imports in the browser-facing SDK sources', () => {
    const files = tsFilesUnder(srcRoot, NODE_ONLY);
    const entryModules = [...readFileSync(join(srcRoot, 'index.ts'), 'utf8').matchAll(/from '\.\/([^']+)\.js'/g)].map(
      ([, module]) => `${module}.ts`,
    );
    expect(entryModules.length).toBeGreaterThan(5);
    for (const module of entryModules) expect(files).toContain(join(srcRoot, module));
    for (const file of files) expect(nodeImportsOf(readFileSync(file, 'utf8')), file).toEqual([]);
  });

  test('the import check sees every import form, and only imports', () => {
    const unsafe = [
      "import { createInterface } from 'readline';",
      "import 'node:fs';",
      "const util = await import('util');",
      "const os = require('os');",
    ].join('\n');
    expect(nodeImportsOf(unsafe)).toEqual(['readline', 'node:fs', 'util', 'os']);
    const safe = [
      "import { Fr } from '@aztec-labs/foundation/curves/bn254';",
      "export * from './allowance.js';",
      "const { siloNullifier } = await import('@aztec-labs/stdlib/hash');",
      "// import { readFile } from 'node:fs';",
      'const hint = "from \'fs\'";',
    ].join('\n');
    expect(nodeImportsOf(safe)).toEqual([]);
  });

  test('the scan does not depend on the checkout path', () => {
    // The link's path ends in operator/test/cli, so matching the absolute path, by substring or by
    // segment, would skip every file.
    const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'quota-browser-safety-'));
    try {
      mkdirSync(join(tmp, 'operator', 'test'), { recursive: true });
      const link = join(tmp, 'operator', 'test', 'cli');
      symlinkSync(srcRoot, link);
      const scan = (root: string) =>
        tsFilesUnder(root, NODE_ONLY)
          .map((file) => relative(root, file))
          .sort();
      expect(scan(link)).toContain('index.ts');
      expect(scan(link)).toEqual(scan(srcRoot));
    } finally {
      // Unlinks the link without following it into the sources.
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the root entrypoint bundles for the browser', () => {
    const outDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'quota-browser-probe-'));
    try {
      execFileSync('bun', ['build', join(srcRoot, 'index.ts'), '--target', 'browser', '--outdir', outDir], {
        stdio: 'pipe',
      });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
