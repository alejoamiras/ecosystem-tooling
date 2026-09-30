import { defineConfig, mergeConfig } from 'vitest/config';
import { base } from './vitest.shared.js';

/**
 * Network-free: unit tests and the examples. The integration and warp suites
 * warp their chain, so they live in their own configs, each booting a
 * disposable network — widening this include would point them at whatever
 * NODE_URL happens to be set.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['src/ts/test/unit/**/*.test.ts', 'examples/**/*.test.ts'],
    },
  }),
);
