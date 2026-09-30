import { defineConfig, mergeConfig } from 'vitest/config';
import { base, NETWORK_SETUP } from './vitest.shared.js';

/** Time-travel tests: many 12h warps per test, on their own disposable network. */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Network boot (minutes) + multiple 12h warps per test.
      hookTimeout: 900_000,
      testTimeout: 900_000,
      globalSetup: [NETWORK_SETUP],
      include: ['src/ts/test/warp/**/*.test.ts'],
    },
  }),
);
