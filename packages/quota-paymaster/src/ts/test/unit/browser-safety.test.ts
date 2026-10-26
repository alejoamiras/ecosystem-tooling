/**
 * Browser-safety probes for the published root export.
 *
 * 1. Static: no import, require() or type import of a node built-in anywhere
 *    under src/ts outside operator/, test/ and cli/.
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

const literal = (node: ts.Node | undefined) => (node && ts.isStringLiteralLike(node) ? [node.text] : []);

// Type imports count, since shipped declarations can keep them.
function specifierOf(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isExternalModuleReference(node)) return node.expression;
  if (ts.isImportTypeNode(node)) return ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
  return loads ? node.arguments[0] : undefined;
}

// The AST, not ts.preProcessFile: that scanner misses `export * as` and a require() inside a template, and reads
// regex text as an import.
function nodeImportsOf(source: string): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    specs.push(...literal(specifierOf(node)));
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest));
  // builtinModules lists most built-ins bare; every built-in also loads as node:<name>.
  return specs.filter((spec) => spec.startsWith('node:') || builtinModules.includes(spec));
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
      "export * as streams from 'node:stream';",
      "const util = await import('util');",
      "const os = require('os');",
      "import path = require('path');",
      "type Threads = typeof import('worker_threads');",
    ].join('\n');
    expect(nodeImportsOf(unsafe)).toEqual([
      'readline',
      'node:fs',
      'node:stream',
      'util',
      'os',
      'path',
      'worker_threads',
    ]);
    const safe = [
      "import { Fr } from '@aztec-labs/foundation/curves/bn254';",
      "export * from './allowance.js';",
      "const { siloNullifier } = await import('@aztec-labs/stdlib/hash');",
      "// import { readFile } from 'node:fs';",
      'const hint = "from \'fs\'";',
      "const pattern = /require('fs')/;",
      "console.log('os');",
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
