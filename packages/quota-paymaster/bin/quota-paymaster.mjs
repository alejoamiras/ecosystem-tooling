#!/usr/bin/env node
// Launcher for the published operator CLI. Plain node over the tsc-compiled
// dist — no loader in this path (the optional tsx dependency is only used to
// read a user's .ts config, never to run the CLI itself).
import { main } from '../dist/src/ts/cli/main.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
