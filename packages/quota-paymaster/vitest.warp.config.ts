import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const nobleUtilsPath = require.resolve('@noble/hashes/utils');

/**
 * The WARP suite's config: time-travel tests that poison their chain, run
 * exclusively against a disposable network the globalSetup boots and owns
 * (plan D5.3). The primary vitest.config.ts cannot discover these tests; this
 * config cannot discover anything else.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@noble/hashes/utils': nobleUtilsPath,
    },
    conditions: ['import', 'module', 'browser', 'default'],
  },
  test: {
    // Network boot (minutes) + multiple 12h warps per test.
    hookTimeout: 900_000,
    testTimeout: 900_000,
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
    execArgv: ['--experimental-vm-modules'],
    globalSetup: ['src/ts/test/warp/global-setup.ts'],
    include: ['src/ts/test/warp/**/*.test.ts'],
    server: {
      deps: {
        inline: [/@aztec/, /@noble\/(hashes|curves|ciphers)/, /viem/, /@scure/],
      },
    },
  },
});
