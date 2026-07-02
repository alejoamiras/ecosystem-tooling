# CI pipeline

All workflows follow the house conventions: per-package PR gates with an internal `changes` path-filter job (never trigger-level `paths:` — skipped jobs satisfy branch protection, missing runs deadlock it), reusable workflows prefixed `_`, default `permissions: contents: read` with per-job write grants, `actions/*` pinned to major tags and **every other external action pinned to a full commit SHA**.

## Workflow map

| Workflow | Trigger | Purpose |
|---|---|---|
| `lint.yml` | PR, dispatch | biome + sort-package-json + advisory `bun audit` |
| `actionlint.yml` | PR, dispatch | Workflow linting (checksum-verified binary, no third-party action) |
| `aztec-benchmark.yml` | PR (path-gated), dispatch | Build (tsc+ncc) + CLI smoke |
| `aztec-standards.yml` | PR (path-gated), dispatch | `_package-checks` (TXE + integration) + `_pr-benchmark` |
| `aztec-fee-payment.yml` | PR (path-gated), dispatch | Same shape as standards |
| `_package-checks.yml` | reusable | `noir-tests` (TXE via `aztec test`, PTY-wrapped) + `js-tests` (vitest vs `aztec start --local-network`, PTY-wrapped) |
| `_pr-benchmark.yml` | reusable | Split-permission benchmark: read-only job runs PR code + uploads report artifact; separate `pull-requests: write` job posts the comment WITHOUT executing PR code. Non-vacuous assertions (results non-empty; baseline present ⇒ ≥1 comparison pair). PR benches run `--skip-proving`. |
| `_update-baseline.yml` | reusable | Full-proving baselines, artifacts namespaced `benchmark-baseline-<pkg>-<branch>` |
| `update-baselines.yml` | push main, monthly cron, dispatch | Baselines for both contract packages |
| `canary.yml` | dispatch | `0.0.0-canary.<sha>` ×3 under `canary` dist-tag via BOOTSTRAP token (env `npm-publish`); post-publish dist-tag assertions |
| `release.yml` | dispatch (`version` input, main only) | See release runbook below |

`setup-aztec` composite action (`.github/actions/setup-aztec`): bun (frozen lockfile) + node 24 + foundry v1.4.1 + aztec CLI pinned from **root `package.json` `config.aztecVersion`** (regex-validated, env-passed, TLS-pinned curl), `~/.aztec` cached by version, optional local network start with :8080 readiness poll, optional per-package compile/codegen.

Measured on `ubuntu-latest` (2026-07-01 spike): toolchain install + compile + codegen + network-ready ≈ **241 s**; full standards TXE suite (329 tests) ≈ **541 s**.

## Release runbook

Versions are LOCKSTEP with the Aztec version. One release = all three packages.

1. Bump: `bun scripts/bump-aztec.ts <version>` → review the sweep + supply-chain report → `bun install` → `bun scripts/bump-aztec.ts --regenerate-excludes` → full local validation → PR → gates green → merge.
2. Dispatch `release.yml` with `version`. The workflow:
   - validates input == root `config.aztecVersion` == every package version (rejects otherwise),
   - **re-runs the full validation on the release sha in-workflow** (TXE + integration + benchmark build) — it never trusts an earlier PR run,
   - packs all three tarballs and runs `bun scripts/verify-tarball.ts` (clean-room **npm** install + every legacy import path),
   - publishes benchmark → standards → fee-payment with `npm publish --provenance` via **trusted publishing** (OIDC; GitHub-hosted runners only; environment `npm-publish`; no token),
   - derives the dist-tag from the prerelease segment (`5.0.0-rc.2` → `rc`; stable → `latest`); canaries can never become `latest`,
   - asserts published versions + dist-tags + provenance attestations,
   - tags `v<version>` and creates the GitHub release.

### One-time publishing bootstrap (COMPLETED 2026-07-02 — kept for reference / future scopes)

1. Before the first canary: create a **scope-level** granular npm automation token (`@alejoamiras`, publish, ≤30-day expiry), store as `NPM_TOKEN` secret in the protected GitHub environment `npm-publish` (require yourself as reviewer).
2. Dispatch `canary.yml` — creates the three package names on npm.
3. On npmjs.com, configure a trusted publisher for each package: repo `alejoamiras/ecosystem-tooling`, workflow `release.yml`, environment `npm-publish`, allowed action `npm publish`.
4. Revoke the bootstrap token. All subsequent releases are tokenless. *(All four steps were executed for the @alejoamiras scope; repeat only if the packages move to a new scope, e.g. aztec-network.)*

## Empirical registry findings (2026-07-02, learned during the rc.2 release)

- **`latest` cannot be deleted** (registry returns E400 on DELETE) — only moved. Policy: `latest` tracks the newest REAL release (rc now, stable later); canaries must never hold it.
- **Trusted-publishing OIDC credentials authorize `npm publish` ONLY** (allowed-actions lockdown): `npm dist-tag` in CI gets E401 by design. Dist-tag maintenance is a manual step with interactive 2FA: `npm dist-tag add @alejoamiras/<pkg>@<version> latest --otp=<code>` (or the browser-auth flow).
- **First-publish sets `latest`** regardless of `--tag` (settled a docs-vs-field dispute between our two audit models — the field was right).
- npm read-API propagation after a first publish can exceed 10 minutes — all CI assertions retry accordingly.
- With package setting "Require 2FA and disallow tokens", even the owner's session token cannot mutate dist-tags — expect the web-auth/OTP dance.

## Local notes

- `bun run lint` / `lint:actions` before pushing workflow changes.
- Local TXE runs (`aztec test`) MUST NOT overlap a running local network on the same machine — LMDB (`mdb_txn_begin: 22`) flakes roam across packages otherwise (macOS; see lessons/phase-3.md). CI is unaffected (separate runners).
- Integration tests expect the local network on :8080 (`NODE_URL` override) and L1 anvil on :8545 (`L1_RPC_URL` override, fee-payment).
