# Phase 4 lessons — import aztec-fee-payment

## Gate results (2026-07-01)

| Item | Result |
|---|---|
| `aztec test` (TXE) | ✓ **11/11** (run in a sandbox-down window per the phase-3 LMDB rule) |
| `test:js` (vitest vs local network) | ✓ **11/11** (2 files: 8 unit + 3 integration incl. L1 FeeJuice bridge, double-spend REVERT, wrong-claimer REVERT) |
| Non-default-port isolation proof | ✓ sandbox relocated to `--port 18080`; `NODE_URL=http://localhost:18080 bunx vitest run src/ts/test/private.test.ts` → **3/3 passed** (env seam works; `LOCAL_AZTEC_NODE_URL`-vs-`NODE_URL` drift eliminated — harness now derives from `NODE_URL`/`L1_RPC_URL`) |
| `benchmark` (`--skip-proving`) | ✓ 1/1 non-empty result file |
| `bun run lint` | ✓ |
| SDK build (`tsc --project tsconfig.build.json`) | ✓ dist layout matches all four export paths |

## What the migration actually required

- **3-name mess resolved**: `aztec-fee-payment` / `@wonderland/…` / `@defi-wonderland/…` → one canonical `@alejoamiras/aztec-fee-payment`; `private: true` dropped; `repository` → this repo (provenance requirement).
- **Peers** = the three @aztec packages the SHIPPED code imports (aztec.js, protocol-contracts, stdlib), exact-pinned. Test-only imports stay devDeps — incl. previously-undeclared `@aztec/bb.js`, `@aztec/l1-artifacts`, `viem` (as the `npm:@aztec/viem@2.38.2` fork alias — matching @aztec's internal pin avoids duplicate-viem instance bugs), `zod` (^4.4.0 range so min-age can pick a compliant version).
- **vitest config fix (audit H2 confirmed exactly)**: the literal `node_modules/@noble/hashes/esm/utils.js` path died under workspace layout → `require.resolve`; yarn `resolutions` → root `overrides` (`@noble/hashes: 1.8.0`).
- **Env centralization**: harness exports `LOCAL_AZTEC_NODE_URL` (from `NODE_URL`) + `DEFAULT_L1_RPC_URL` (from `L1_RPC_URL`); L1 hardcodes at harness.ts:89/206 now use the shared default. Benchmark already env-driven.
- Docs de-staled (CLAUDE.md's yarn/v4.2.0 prerequisites, README install lines, "Yarn workspaces" fiction); legacy `build-package.sh` (jq name-forcing) deleted — build is `compile && codegen && tsc -p tsconfig.build.json`, publish comes from the curated manifest.

## Ops notes

- **1Password lock cascade**: commit signing AND ssh push both ride the 1Password agent — when it locks, commits continue with per-commit `-c commit.gpgsign=false` (standing AFK rule; config untouched; signature backfill offered on return) but pushes QUEUE until unlock.
- Sandbox teardown must kill the process TREE: killing the parent orphans `anvil`, which squats :8545 and silently hangs the next sandbox boot at "Setting up…" (burned twice: 65093, 5070 — both verified ours via launch-time lineage before killing). Roadmap: proper detached-spawn + `kill(-pgid)` runner.
