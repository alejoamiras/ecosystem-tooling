import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// require.resolve survives workspace hoisting; the single-version pin lives in
// the ROOT package.json `overrides`. (Same load-bearing shape as private-fee-juice.)
const require = createRequire(import.meta.url);
const nobleUtilsPath = require.resolve('@noble/hashes/utils');

/**
 * What every suite config shares. Each config then owns exactly one `include`
 * and whether it boots a network: the unit config never does, the integration
 * and warp configs always boot their own disposable one (they warp the chain).
 */
export const base = defineConfig({
  resolve: {
    alias: {
      '@noble/hashes/utils': nobleUtilsPath,
    },
    conditions: ['import', 'module', 'browser', 'default'],
  },
  test: {
    // Live-network steps (deploy, bridge, claim) take tens of seconds each.
    hookTimeout: 600_000,
    testTimeout: 600_000,
    fileParallelism: false,
    pool: 'forks',
    // vitest 4 removed poolOptions; the single-fork/no-isolation shape is
    // top-level (private-fee-juice uses the same shape — keep both in step).
    maxWorkers: 1,
    isolate: false,
    execArgv: ['--experimental-vm-modules'],
    server: {
      deps: {
        inline: [/@aztec(-labs|-foundation)?\//, /@noble\/(hashes|curves|ciphers)/, /viem/, /@scure/],
      },
    },
  },
});

/** Boots, and tears down by owned pgid, one disposable network per vitest run. */
export const NETWORK_SETUP = 'src/ts/test/network/global-setup.ts';
