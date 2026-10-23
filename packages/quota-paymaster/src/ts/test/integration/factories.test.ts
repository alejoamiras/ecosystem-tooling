/**
 * schnorrAccountFromEnv against a live node, with the real wallet: where its stores land is
 * decided inside the wallet, so only a real create() proves the factory's contract.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { describe, expect, test } from 'vitest';
import { schnorrAccountFromEnv } from '../../operator/factories.js';
import { NODE_URL } from '../harness.js';

describe('schnorrAccountFromEnv on a live node', () => {
  test('keeps the wallet stores in the directory it owns, and dispose() removes them', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'quota-factory-'));
    const workDir = join(scratch, 'cwd');
    const ownTmp = join(scratch, 'tmp');
    mkdirSync(workDir);
    mkdirSync(ownTmp);
    const saved = { cwd: process.cwd(), tmpdir: process.env.TMPDIR };
    const owned = () => readdirSync(ownTmp).filter((name) => name.startsWith('quota-operator-wallet-'));
    // The suite runs in one forked worker with no file parallelism, so the process-wide
    // cwd and TMPDIR can be swapped for this test and restored after it.
    process.chdir(workDir);
    process.env.TMPDIR = ownTmp;
    let dispose: (() => Promise<void>) | undefined;
    try {
      const ctx = await schnorrAccountFromEnv({
        env: {
          NODE_URL,
          ACCOUNT_SECRET_KEY: Fr.random().toString(),
          ACCOUNT_SALT: Fr.random().toString(),
          ACCOUNT_SIGNING_KEY: Fq.random().toString(),
        },
      })();
      dispose = ctx.dispose;
      const [dir, ...others] = owned();
      expect(others).toEqual([]);
      expect(readdirSync(join(ownTmp, dir as string))).toEqual(
        expect.arrayContaining(['pxe_data-stores', 'wallet_data-stores']),
      );
      expect(existsSync(join(workDir, 'aztec-wallet-data'))).toBe(false);

      dispose = undefined;
      await ctx.dispose?.();
      expect(owned()).toEqual([]);
    } finally {
      try {
        await dispose?.();
      } finally {
        process.chdir(saved.cwd);
        if (saved.tmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = saved.tmpdir;
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });
});
