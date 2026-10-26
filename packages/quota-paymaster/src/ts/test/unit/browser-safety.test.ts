/**
 * Browser-safety probes for the published root export.
 *
 * 1. Static: no `node:` (or bare node-builtin) imports anywhere under src/ts
 *    outside operator/, test/ and cli/.
 * 2. Behavioral: `bun build --target browser` bundles the root entrypoint
 *    without error. Bun stubs node built-ins, so this cannot stand in for 1.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('browser safety', () => {
  test('no node-only imports in the browser-facing SDK sources', () => {
    const files = tsFilesUnder(srcRoot, NODE_ONLY);
    const entryModules = [...readFileSync(join(srcRoot, 'index.ts'), 'utf8').matchAll(/from '\.\/([^']+)\.js'/g)].map(
      ([, module]) => `${module}.ts`,
    );
    expect(entryModules.length).toBeGreaterThan(5);
    for (const module of entryModules) expect(files).toContain(join(srcRoot, module));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const nodeImport = source.match(/from\s+['"](node:[^'"]+|fs|path|os|crypto|child_process)['"]/);
      expect(nodeImport, `${file} imports ${nodeImport?.[1]}`).toBeNull();
    }
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
