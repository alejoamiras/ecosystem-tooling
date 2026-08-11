/**
 * Browser-safety probes for the published root export.
 *
 * 1. Static: no `node:` (or bare node-builtin) imports anywhere under src/ts
 *    outside operator/ and test/.
 * 2. Behavioral: `bun build --target browser` bundles the root entrypoint
 *    without error. (The operator entrypoint is expected to FAIL this — that
 *    probe lands with the operator module in Phase 4.)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const srcRoot = new URL('../..', import.meta.url).pathname;

function tsFilesUnder(dir: string, skip: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (skip.some((s) => full.includes(s))) continue;
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full, skip));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('browser safety', () => {
  test('no node-only imports in the browser-facing SDK sources', () => {
    // /cli is node-only for the same reason /operator is: it reads files,
    // spawns readline, and loads the operator's config module.
    const files = tsFilesUnder(srcRoot, ['/operator', '/test', '/cli']);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const nodeImport = source.match(/from\s+['"](node:[^'"]+|fs|path|os|crypto|child_process)['"]/);
      expect(nodeImport, `${file} imports ${nodeImport?.[1]}`).toBeNull();
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
