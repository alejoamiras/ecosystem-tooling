# ecosystem-tooling

Bun monorepo consolidating Wonderland's Aztec packages (`aztec-fee-payment`, `aztec-benchmark`) under the `@alejoamiras` npm scope. Versions are LOCKSTEP with the Aztec version they target. `aztec-standards` lived here through 5.0.0 and was handed over to the Aztec Foundation (July 2026) — it is now [`@aztec-foundation/aztec-standards`](https://www.npmjs.com/package/@aztec-foundation/aztec-standards); the `@alejoamiras/aztec-standards` npm package is deprecated.

## Current state

**Live**: both packages released as `@alejoamiras/*` on npm (`latest`, provenance attestations, attestation-identity verified) via the tokenless OIDC `release.yml` (mode-based: release/rehearsal/hotfix; rehearse-then-release choreography with SHA binding + payload comparison). Consolidation + the 5.0.0 stable migration + the standards handover plans are COMPLETE (local-only under `implementations-plan/`); `docs/roadmap.md` tracks what's next; `docs/ci-pipeline.md` has the full release runbook.

## Commands

- `bun install` — min-age supply-chain gate active (bunfig.toml); `@aztec/*` excluded deliberately
- `bun run lint` / `lint:fix` — biome + sort-package-json
- `bun run lint:actions` — actionlint (run before pushing workflow changes)
- `bun run typecheck` — full-surface tsc (src + tests + benchmarks + scripts, all packages)
- `bun run test:nr` — Noir TXE tests per package (`aztec test`); count floor: fee-payment 11
- `bun run test:js` — vitest integration tests; need `aztec start --local-network` (node :8080, L1 :8545; override via `NODE_URL` / `L1_RPC_URL`)
- `bun run bench` — aztec-benchmark suites (local network required)

## Hard conventions (from the approved plan)

- **Aztec version single source of truth**: root `package.json` `config.aztecVersion`. Bumps ONLY via `bun scripts/bump-aztec.ts <version>` (sweeps package.json pins, Nargo.toml tags, PRD header; regenerates bunfig exclusions; emits an alias-aware supply-chain report) + `scripts/verify-nargo-refs.sh --write` (commit-locks every Nargo git tag; verified on every release build).
- **Internal cross-package deps: exact lockstep pins, NEVER `workspace:*`** (npm CLI publishes the protocol string verbatim — breaks consumers).
- **Published manifests are curated**: no lifecycle scripts, `@aztec/*` as exact peerDependencies, `repository` must point at THIS repo (provenance validates it).
- **Publish order: benchmark → fee-payment.** rc versions get the `rc` dist-tag, never `latest`; emergency fixes to a published lockstep version ship as `<version>-revision.N` (dist-tag `revision`, `latest` moved manually with OTP).
- **Releases go through the rehearse-then-release choreography** (docs/ci-pipeline.md runbook): rehearsal publishes `0.0.0-canary.g<sha>` through the REAL release.yml; the release then binds to that commit (`expected-head-sha`) and byte-compares against the rehearsed tarballs (`compare-against`). Never relax the fail-closed tarball assertions.
- **Keep vitest** for migrated suites (forks pool + inline @aztec deps are load-bearing); bun replaces yarn as PM/script-runner only.
- Noir formatting via `aztec-nargo fmt` (pre-commit hook); TS/JSON via biome.
- Workflows: per-package gates with internal `changes` path-filter job (never trigger-level `paths:` — deadlocks required checks). `actions/*` may use major tags; ALL other actions full-SHA pinned.
