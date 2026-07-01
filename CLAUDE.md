# ecosystem-tooling

Bun monorepo consolidating Wonderland's Aztec packages (`aztec-standards`, `aztec-fee-payment`, `aztec-benchmark`) under the `@alejoamiras` npm scope. Versions are LOCKSTEP with the Aztec version they target.

## Current state

Bootstrapping per `implementations-plan/wonderland-consolidation/plan.md` (APPROVED — read it before non-trivial work; the decision ledger §7 explains every convention below).

## Commands

- `bun install` — min-age supply-chain gate active (bunfig.toml); `@aztec/*` excluded deliberately
- `bun run lint` / `lint:fix` — biome + sort-package-json
- `bun run lint:actions` — actionlint (run before pushing workflow changes)
- `bun run test:nr` — Noir TXE tests per package (`aztec test`)
- `bun run test:js` — vitest integration tests; need `aztec start --local-network` (node :8080, L1 :8545; override via `NODE_URL` / `L1_RPC_URL`)
- `bun run bench` — aztec-benchmark suites (local network required)

## Hard conventions (from the approved plan)

- **Aztec version single source of truth**: root `package.json` `config.aztecVersion`. Bumps ONLY via `bun scripts/bump-aztec.ts <version>` (sweeps package.json pins, Nargo.toml tags, PRD header; regenerates bunfig exclusions; emits supply-chain report).
- **Internal cross-package deps: exact lockstep pins, NEVER `workspace:*`** (npm CLI publishes the protocol string verbatim — breaks consumers).
- **Published manifests are curated**: no lifecycle scripts, `@aztec/*` as exact peerDependencies, `repository` must point at THIS repo (provenance validates it).
- **Publish order: benchmark → standards/fee-payment.** rc versions get the `rc` dist-tag, never `latest`.
- **Keep vitest** for migrated suites (forks pool + inline @aztec deps are load-bearing); bun replaces yarn as PM/script-runner only.
- Noir formatting via `aztec-nargo fmt` (pre-commit hook); TS/JSON via biome.
- Workflows: per-package gates with internal `changes` path-filter job (never trigger-level `paths:` — deadlocks required checks). `actions/*` may use major tags; ALL other actions full-SHA pinned.
