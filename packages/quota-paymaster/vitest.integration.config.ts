import { defineConfig, mergeConfig } from 'vitest/config';
import { base, NETWORK_SETUP } from './vitest.shared.js';

/**
 * The integration suite. Every paymaster is inert for its first hour, so each
 * file warps past activation in `beforeAll` — against its own disposable
 * network, never a shared one.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      globalSetup: [NETWORK_SETUP],
      include: ['src/ts/test/integration/**/*.test.ts'],
    },
  }),
);
