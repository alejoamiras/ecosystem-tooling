/**
 * The config-module contract: what a valid operator config looks like, and
 * that every invalid one fails with a typed error naming the fix — never
 * echoing a key value.
 *
 * Config fixtures are written to real temp files and loaded through the real
 * loader: module loading IS the behavior under test, so mocking it would test
 * nothing (same discipline as journal.test.ts using real files).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  assertOperatorContext,
  defineOperatorConfig,
  loadOperatorConfigModule,
  OperatorConfigError,
  resolveOperatorContext,
} from '../../operator/config-module.js';
import { schnorrAccountFromEnv } from '../../operator/factories.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function fixture(filename: string, contents: string): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'quota-config-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, filename);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

/** A context shaped enough to satisfy structural validation. */
const fakeContext = `{ node: {}, wallet: {}, from: { toString: () => '0xabc' } }`;

describe('defineOperatorConfig', () => {
  test('brands the config and keeps the factory callable', async () => {
    const config = defineOperatorConfig(async () => ({}) as never);
    expect(config.__quotaPaymasterConfig).toBe(true);
    expect(typeof config.load).toBe('function');
  });

  test('refuses a non-function factory at authoring time', () => {
    expect(() => defineOperatorConfig(undefined as never)).toThrow(OperatorConfigError);
  });
});

describe('loadOperatorConfigModule', () => {
  test('loads a .mjs config with NO loader dependency', async () => {
    const path = fixture(
      'quota-paymaster.config.mjs',
      `export default { __quotaPaymasterConfig: true, load: async () => (${fakeContext}) };`,
    );
    const config = await loadOperatorConfigModule(path);
    expect(config.__quotaPaymasterConfig).toBe(true);
    await expect(resolveOperatorContext(config)).resolves.toMatchObject({ node: {}, wallet: {} });
  });

  test('accepts the CJS-interop shape a TS loader produces (mod.default.default)', async () => {
    // The Phase-1 spike found tsImport returns TS modules through an interop
    // wrapper, so the config lands one level deeper than for .mjs. Unwrapping
    // is brand-aware, so BOTH shapes resolve — and a config that merely owns a
    // `default` property (below) is not mistaken for the wrapper.
    const path = fixture(
      'wrapped.config.mjs',
      `export default { __esModule: true, default: { __quotaPaymasterConfig: true, load: async () => (${fakeContext}) } };`,
    );
    const config = await loadOperatorConfigModule(path);
    expect(config.__quotaPaymasterConfig).toBe(true);
  });

  test('a valid config that owns a `default` property is not unwrapped past itself', async () => {
    const path = fixture(
      'ownsdefault.config.mjs',
      `export default { __quotaPaymasterConfig: true, default: 'not-the-config', load: async () => (${fakeContext}) };`,
    );
    const config = await loadOperatorConfigModule(path);
    expect(config.__quotaPaymasterConfig).toBe(true);
  });

  test('a missing file is `not-found`, not a crash', async () => {
    await expect(loadOperatorConfigModule('/nonexistent/quota-paymaster.config.mjs')).rejects.toMatchObject({
      reason: 'not-found',
    });
  });

  test('no default export names the fix', async () => {
    const path = fixture('nodefault.config.mjs', `export const notDefault = 1;`);
    await expect(loadOperatorConfigModule(path)).rejects.toMatchObject({ reason: 'no-default-export' });
    await expect(loadOperatorConfigModule(path)).rejects.toThrow(/defineOperatorConfig/);
  });

  test('a non-defineOperatorConfig default explains the dual-copy possibility', async () => {
    const path = fixture('plain.config.mjs', `export default { load: async () => ({}) };`);
    const error = await loadOperatorConfigModule(path).catch((e) => e);
    expect(error).toBeInstanceOf(OperatorConfigError);
    expect(error.reason).toBe('not-defineOperatorConfig');
    // The npx-cache-vs-local-install case is the likely real cause; say so.
    expect(error.message).toMatch(/DIFFERENT copy/);
  });

  test('a config that throws while loading is `load-failed`, wrapped not swallowed', async () => {
    const path = fixture('throws.config.mjs', `throw new Error('boom from user config');`);
    const error = await loadOperatorConfigModule(path).catch((e) => e);
    expect(error.reason).toBe('load-failed');
    expect(error.cause).toBeDefined();
  });
});

describe('resolveOperatorContext', () => {
  test('a factory that throws is `factory-threw` with the cause preserved', async () => {
    const config = defineOperatorConfig(async () => {
      throw new Error('no keys today');
    });
    const error = await resolveOperatorContext(config).catch((e) => e);
    expect(error.reason).toBe('factory-threw');
    expect(error.message).toMatch(/no keys today/);
  });

  test('a malformed context names the missing fields', async () => {
    const config = defineOperatorConfig(async () => ({ node: {} }) as never);
    const error = await resolveOperatorContext(config).catch((e) => e);
    expect(error.reason).toBe('shape-invalid');
    expect(error.message).toMatch(/wallet/);
    expect(error.message).toMatch(/from/);
  });

  test('assertOperatorContext accepts the minimal valid shape', () => {
    expect(() => assertOperatorContext({ node: {}, wallet: {}, from: { toString: () => '0x1' } })).not.toThrow();
  });
});

describe('schnorrAccountFromEnv — key handling', () => {
  test('missing required vars fail by NAME before anything else happens', async () => {
    const factory = schnorrAccountFromEnv({ env: {} });
    const error = await factory().catch((e) => e);
    expect(error).toBeInstanceOf(OperatorConfigError);
    expect(error.message).toMatch(/ACCOUNT_SECRET_KEY/);
  });

  test('a malformed key value is reported WITHOUT echoing the value', async () => {
    // The real leak path: Fr/Fq.fromString errors embed the raw input, so the
    // factory must catch and re-raise without it.
    const secret = 'zzz-not-a-field-element-zzz';
    const factory = schnorrAccountFromEnv({
      env: {
        ACCOUNT_SECRET_KEY: secret,
        ACCOUNT_SALT: '0x1',
        ACCOUNT_SIGNING_KEY: '0x2',
      },
    });
    const error = await factory().catch((e) => e);
    expect(error).toBeInstanceOf(OperatorConfigError);
    expect(error.message).toMatch(/ACCOUNT_SECRET_KEY/);
    expect(error.message).not.toContain(secret);
    expect(String(error.stack ?? '')).not.toContain(secret);
  });
});
