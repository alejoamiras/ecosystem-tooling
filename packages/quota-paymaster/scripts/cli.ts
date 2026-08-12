#!/usr/bin/env bun
/**
 * Repo-local entry to the operator CLI, for developing against LOCAL networks.
 *
 * The CLI itself lives in `src/ts/cli/` and ships with the package; this file
 * exists only so contributors can run it from source without a build:
 *
 *   bun scripts/cli.ts policy --fpc 0x… --config-module ./my.config.mjs --show
 *
 * There is deliberately no second implementation here — a forked copy would
 * drift from the published one, and the published one is what operators run.
 * For local networks, `examples/local-network.config.mjs` is a ready-made
 * config module using the pre-registered test accounts.
 */
import { main } from '../src/ts/cli/main.js';

// Same default-to-failure as the published launcher (round-18).
process.exitCode = 1;

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
