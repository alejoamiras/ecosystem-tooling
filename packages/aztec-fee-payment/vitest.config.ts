import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// require.resolve survives workspace hoisting (the previous literal
// `node_modules/@noble/hashes/esm/utils.js` path only existed pre-monorepo);
// the single-version pin lives in the ROOT package.json `overrides`.
const require = createRequire(import.meta.url);
const nobleUtilsPath = require.resolve('@noble/hashes/utils');

export default defineConfig({
  resolve: {
    alias: {
      // Force a concrete file path so CI doesn't resolve a nested version without `anumber`
      '@noble/hashes/utils': nobleUtilsPath,
    },
    conditions: ['import', 'module', 'browser', 'default'],
  },
  test: {
    // aztec local network tests take quite some time
    hookTimeout: 200000,
    testTimeout: 200000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        isolate: false,
        execArgv: ['--experimental-vm-modules'],
      },
    },
    include: ['src/ts/test/**/*.test.ts'],
    // Use new API to inline dependencies through Vite's transform pipeline
    server: {
      deps: {
        inline: [/@aztec/, /@noble\/(hashes|curves|ciphers)/, /viem/, /@scure/],
      },
    },
  },
});
