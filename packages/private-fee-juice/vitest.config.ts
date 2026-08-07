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
    // vitest 4 removed poolOptions — the old poolOptions.forks block was being
    // silently ignored (masked by fileParallelism: false serializing files
    // anyway). The single-fork/no-isolation shape is expressed top-level, same
    // as quota-paymaster's config.
    maxWorkers: 1,
    isolate: false,
    execArgv: ['--experimental-vm-modules'],
    include: ['src/ts/test/**/*.test.ts'],
    // Use new API to inline dependencies through Vite's transform pipeline
    server: {
      deps: {
        inline: [/@aztec/, /@noble\/(hashes|curves|ciphers)/, /viem/, /@scure/],
      },
    },
  },
});
