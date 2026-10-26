/**
 * Browser-safety probes for the published root export.
 *
 * 1. Static: no module under src/ts outside operator/, test/ and cli/ loads a
 *    node built-in, or a local module the scan does not read.
 * 2. Behavioral: `bun build --target browser` bundles the root entrypoint
 *    without error. Bun stubs node built-ins, so this cannot stand in for 1.
 *
 * Known limit: computed specifiers and loader aliases go unseen (import(x), 'node:' + x, `node:${x}`, load = require).
 * Known limit: a local binding named require is still read as a load, a conservative false positive.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
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

// Parentheses and type assertions do not change which module a call loads.
function unwrap(node: ts.Node): ts.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  )
    node = node.expression;
  return node;
}

const literal = (node: ts.Node | undefined) => {
  const value = node && unwrap(node);
  return value && ts.isStringLiteralLike(value) ? [value.text] : [];
};

function nameOf(node: ts.Node): string {
  const bare = unwrap(node);
  if (bare.kind === ts.SyntaxKind.ImportKeyword) return 'import';
  if (ts.isIdentifier(bare)) return bare.text;
  if (!ts.isPropertyAccessExpression(bare)) return '';
  const object = nameOf(bare.expression);
  return object && `${object}.${bare.name.text}`;
}

// Callees that load their first argument as a module.
const LOADERS = [
  'import',
  'require',
  'module.require',
  'process.getBuiltinModule',
  'globalThis.process.getBuiltinModule',
];

// Type imports count, since shipped declarations can keep them.
function specifierOf(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isExternalModuleReference(node)) return node.expression;
  if (ts.isImportTypeNode(node)) return ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
  if (!ts.isCallExpression(node)) return undefined;
  return LOADERS.includes(nameOf(node.expression)) ? node.arguments[0] : undefined;
}

// The AST, not ts.preProcessFile: that scanner misses `export * as` and a require() inside a template, and reads
// regex text as an import.
function specifiersOf(source: string): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    specs.push(...literal(specifierOf(node)));
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest));
  return specs;
}

// builtinModules lists most built-ins bare; every built-in also loads as node:<name>.
const nodeImportsOf = (source: string) =>
  specifiersOf(source).filter((spec) => spec.startsWith('node:') || builtinModules.includes(spec));

const isLocal = (spec: string) => spec.startsWith('./') || spec.startsWith('../');

// NodeNext names a .ts source by its emitted .js; any other local target is a file the scan does not read.
const unscannedImportsOf = (file: string, source: string, scanned: string[]) =>
  specifiersOf(source)
    .filter(isLocal)
    .filter((spec) => !scanned.includes(resolve(dirname(file), spec.replace(/\.js$/, '.ts'))));

describe('browser safety', () => {
  test('no node-only imports in the browser-facing SDK sources', () => {
    const files = tsFilesUnder(srcRoot, NODE_ONLY);
    // The loop fails on any local import the scan skips, so these two cover what the entrypoint re-exports.
    const index = join(srcRoot, 'index.ts');
    expect(files).toContain(index);
    expect(specifiersOf(readFileSync(index, 'utf8')).filter(isLocal).length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(nodeImportsOf(source), file).toEqual([]);
      expect(unscannedImportsOf(file, source, files), file).toEqual([]);
    }
  });

  test('the import check sees every import form, and only imports', () => {
    const unsafe: [string, string][] = [
      ["import { createInterface } from 'readline';", 'readline'],
      ["import 'node:fs';", 'node:fs'],
      ["export * as streams from 'node:stream';", 'node:stream'],
      ["const util = await import('util');", 'util'],
      ["const os = require('os');", 'os'],
      ["import path = require('path');", 'path'],
      ["type Threads = typeof import('worker_threads');", 'worker_threads'],
      ["const fs = require(('fs'));", 'fs'],
      ["(require)('node:net');", 'node:net'],
      ["const zlib = await import('node:zlib' as string);", 'node:zlib'],
      ["require('dns' satisfies string);", 'dns'],
      ["require(<string>'tls');", 'tls'],
      ["require!('http');", 'http'],
      ["process.getBuiltinModule('crypto');", 'crypto'],
      ["globalThis.process?.getBuiltinModule?.('v8');", 'v8'],
      ["module.require('node:vm');", 'node:vm'],
    ];
    expect(nodeImportsOf(unsafe.map(([line]) => line).join('\n'))).toEqual(unsafe.map(([, spec]) => spec));
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

  test('a scanned module imports only scanned local modules', () => {
    const files = tsFilesUnder(srcRoot, NODE_ONLY);
    const importer = join(srcRoot, 'duration.ts');
    const unsafe = [
      'export { createActionPlan } from "./operator/action-plan.js";',
      "export { run } from /* entry */ './cli/run.js';",
      "const fixtures = await import('./test/fixtures.js');",
      "import { legacy } from './legacy.js';",
      "import './worker.mjs';",
    ];
    expect(unscannedImportsOf(importer, unsafe.join('\n'), files)).toEqual([
      './operator/action-plan.js',
      './cli/run.js',
      './test/fixtures.js',
      './legacy.js',
      './worker.mjs',
    ]);
    const safe = [
      "export * from './errors.js';",
      "import { createSendOnceContext } from './client/send-once.js';",
      "// export * from './test/helpers.js';",
      "import { Fr } from '@aztec-labs/foundation/curves/bn254';",
    ].join('\n');
    expect(unscannedImportsOf(importer, safe, files)).toEqual([]);
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
