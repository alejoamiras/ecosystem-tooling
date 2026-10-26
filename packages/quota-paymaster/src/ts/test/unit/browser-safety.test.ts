/**
 * Browser-safety probes for the published root export.
 *
 * 1. Static: no `node:` (or bare node-builtin) imports anywhere under src/ts
 *    outside operator/, test/ and cli/.
 * 2. Behavioral: `bun build --target browser` bundles the root entrypoint
 *    without error.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const srcRoot = fileURLToPath(new URL('../..', import.meta.url));
// Top-level directories of the scanned root, matched by name: neither the checkout path nor a
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
    // cli/ is node-only for the same reason operator/ is: it reads files,
    // spawns readline, and loads the operator's config module.
    const files = tsFilesUnder(srcRoot, NODE_ONLY);
    const scanned = files.map((file) => relative(srcRoot, file));
    const entryModules = [...readFileSync(join(srcRoot, 'index.ts'), 'utf8').matchAll(/from '\.\/([^']+)\.js'/g)].map(
      ([, module]) => `${module}.ts`,
    );
    expect(entryModules.length).toBeGreaterThan(5);
    for (const module of entryModules) expect(scanned).toContain(module);
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
