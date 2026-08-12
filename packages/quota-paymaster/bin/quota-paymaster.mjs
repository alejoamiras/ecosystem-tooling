#!/usr/bin/env node
// Launcher for the published operator CLI. Plain node over the tsc-compiled
// dist — no loader in this path (the optional tsx dependency is only used to
// read a user's .ts config, never to run the CLI itself).
import { main } from '../dist/src/ts/cli/main.js';

// Failure is the DEFAULT until a settled outcome overwrites it. Without this,
// any promise that never settles — a config module's dispose() awaiting an
// event that already fired, for instance — drains the event loop and exits 0,
// reporting success for a command that may have just moved money (round-18).
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
