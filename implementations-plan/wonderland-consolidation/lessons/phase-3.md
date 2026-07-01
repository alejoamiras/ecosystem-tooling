# Phase 3 lessons — import aztec-standards

## Gate results (2026-07-01)

| Item | Result |
|---|---|
| `compile` + `codegen` | ✓ 8 contracts → target/*.json → 8 TS bindings |
| `build` (scripts/build.sh: tsc → artifacts/ + dist/ mirror + inspect-contract ×8 + deployments.json copy) | ✓ BUILD_OK |
| `aztec test` (TXE) | ✓ **329/329** (isolated run; see flake saga below) |
| `test:js` (vitest vs local network) | ✓ **29/29 passed**, 7 conditional skips (4 files) |
| `bench` (`--skip-proving`) | ✓ 5/5 suites produced non-empty `*_base.benchmark.json` |
| `bun run lint` | ✓ |
| CI spike (ubuntu-latest, run 28551957270 @ e6af4aa) | ✓ **ALL GREEN**: setup+compile+codegen+network **238s**, full TXE **539s**, token.test.ts **58s** → **I1 CONFIRMED** — free 4-core runners suffice; spike #1 (pre-fix commit) failed only on the then-undeclared noble dep |

## The isolated-linker dependency saga (biggest lesson)

bun 1.3's isolated linker exposes every undeclared import that yarn hoisting silently forgave. Found one-at-a-time (do a FULL import sweep upfront next time — `grep -rhoE "from ['\"]" src/ scripts/ benchmarks/`):
1. `@aztec/bb.js` (test utils) — codex round-1's literal named example
2. `@aztec/foundation/branded-types` (escrow test)
3. `@aztec/constants`
4. `@noble/hashes` (vitest config `require.resolve` — resolution ALSO fails under isolation when undeclared, not just literal paths) → declared + ROOT `overrides` pin 1.8.0 (replaces fee-payment's yarn `resolutions`)
5. `viem` in benchmark suites — **Aztec ships a viem FORK**: must be declared as the alias `"viem": "npm:@aztec/viem@2.38.2"` (matching the version @aztec/* pins internally) or you get duplicate/mismatched viem instances

Also: benchmark files still imported `@defi-wonderland/aztec-benchmark` after the manifest rename — import-site sweeps are part of any scope rename (fixed across 6 files + README).

## The roaming LMDB flake (second biggest)

`aztec test` intermittently fails with `mdb_txn_begin: 22 - Invalid argument` (world-state SYNC_BLOCK) — 2 failures with vitest+sandbox running concurrently, 1 failure (different package!) with sandbox merely idle, **0 failures with the sandbox stopped**. Rule adopted (docs/ci-pipeline.md): local TXE runs get the machine's sandbox stopped; CI unaffected (fresh runners). macOS-specific; not test logic — same tests pass on re-run and on ubuntu.

## Ops footguns burned

- Background compound commands MUST use absolute paths — the Bash tool's persistent cwd broke two chain launches (`cd packages/...` from inside another package).
- `cmd | tail -N && next` masks `cmd`'s exit code — two "green" runs were actually failures. Capture `rc=$?` before piping or check the log.
- Killing a sandbox by parent PID orphans its anvil child, which then squats :8545 and silently hangs the NEXT sandbox's boot at "Setting up..." — kill the process GROUP or sweep children (ownership verified via launch-time correlation before killing). Exactly the failure my run-isolation rules predict; the real fix (spawn detached + kill(-pgid)) is the roadmap item.

## Decisions

- Local gate benches run `--skip-proving` (measures gates/gas; skips proving time). Full-proving baselines are CI's job (`update-baselines.yml`). Consistent with D17/A7 (non-vacuous report gate).
- Kept the legacy `tsc` CLI-flag build (parity with build-package.sh output) instead of a tsconfig.build.json — byte-compatible artifacts trump config aesthetics for a compatibility release.
