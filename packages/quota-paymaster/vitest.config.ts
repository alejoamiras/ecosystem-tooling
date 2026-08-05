import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// require.resolve survives workspace hoisting; the single-version pin lives in
// the ROOT package.json `overrides`. (Same load-bearing shape as private-fee-juice.)
const require = createRequire(import.meta.url);
const nobleUtilsPath = require.resolve('@noble/hashes/utils');

export default defineConfig({
  resolve: {
    alias: {
      '@noble/hashes/utils': nobleUtilsPath,
    },
    conditions: ['import', 'module', 'browser', 'default'],
  },
  test: {
    // Live-network steps (deploy, bridge, claim) take tens of seconds each; the
    // source suite ran at 600s and the sibling's 200s is not enough here.
    hookTimeout: 600000,
    testTimeout: 600000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        isolate: false,
        execArgv: ['--experimental-vm-modules'],
      },
    },
    // Mechanical warp quarantine (plan D5.3): time-travel suites live under
    // src/ts/test/warp/ and are UNDISCOVERABLE by this config — they run only via
    // `bun run test:warp` (vitest.warp.config.ts), which provisions its own
    // disposable network. Do not widen this include.
    include: ['src/ts/test/unit/**/*.test.ts', 'src/ts/test/integration/**/*.test.ts'],
    server: {
      deps: {
        inline: [/@aztec/, /@noble\/(hashes|curves|ciphers)/, /viem/, /@scure/],
      },
    },
  },
});
