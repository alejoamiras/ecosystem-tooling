# CI pipeline

All workflows follow the house conventions: per-package PR gates with an internal `changes` path-filter job (never trigger-level `paths:` — skipped jobs satisfy branch protection, missing runs deadlock it), reusable workflows prefixed `_`, default `permissions: contents: read` with per-job write grants, `actions/*` pinned to major tags and **every other external action pinned to a full commit SHA**.

## Workflow map

| Workflow | Trigger | Purpose |
|---|---|---|
| `lint.yml` | PR, dispatch | biome + sort-package-json + advisory `bun audit` |
| `actionlint.yml` | PR, dispatch | Workflow linting (checksum-verified binary, no third-party action) |
| `aztec-benchmark.yml` | PR (path-gated), dispatch | Build (tsc+ncc) + CLI smoke |
| `aztec-standards.yml` | PR (path-gated), dispatch | `_package-checks` (TXE + integration, floor 329) + `_pr-benchmark` |
| `aztec-fee-payment.yml` | PR (path-gated), dispatch | Same shape as standards (floor 11) |
| `_package-checks.yml` | reusable | `noir-tests` (TXE via `aztec test`, PTY-wrapped, **count floor via `scripts/check-txe-counts.sh`** — exit codes alone let silently-skipped suites pass) + `js-tests` (full-surface `bun run typecheck`, then vitest vs `aztec start --local-network`, PTY-wrapped) |
| `_pr-benchmark.yml` | reusable | Split-permission benchmark: read-only job runs PR code + uploads report artifact; separate `pull-requests: write` job posts the comment WITHOUT executing PR code. Non-vacuous assertions (results non-empty; baseline present ⇒ ≥1 comparison pair). PR benches run `--skip-proving`. |
| `_update-baseline.yml` | reusable | Full-proving baselines, artifacts namespaced `benchmark-baseline-<pkg>-<branch>` |
| `update-baselines.yml` | push main, monthly cron, dispatch | Baselines for both contract packages |
| `release.yml` | dispatch (main only; `version` + `mode` + optional SHA-binding inputs) | See release runbook below. Rehearsals run through THIS workflow (`mode: rehearsal`) — the bootstrap-era `canary.yml` (revoked-token based, could not attest provenance) was retired at 5.0.0 |

`setup-aztec` composite action (`.github/actions/setup-aztec`): bun (frozen lockfile) + node 24 + foundry v1.4.1 (matches upstream's pin at v5.0.0) + aztec CLI pinned from **root `package.json` `config.aztecVersion`** (regex-validated, env-passed, TLS-pinned curl), `~/.aztec` cached by version, optional local network start with :8080 readiness poll, optional per-package compile/codegen.

Nargo git dependencies are tag-pinned in manifests but **commit-locked** in `nargo-deps.lock.json`: `scripts/verify-nargo-refs.sh` (run in release validation; `--write` to regenerate on bumps) fails bidirectionally on moved refs OR unlocked deps — a silently moved upstream tag cannot change published bytecode.

Measured on `ubuntu-latest` (2026-07-01 spike): toolchain install + compile + codegen + network-ready ≈ **241 s**; full standards TXE suite (329 tests) ≈ **541 s**.

## Release runbook

Versions are LOCKSTEP with the Aztec version. One release = all three packages. Since 5.0.0 the workflow has three modes and a mandatory rehearse-then-release choreography.

1. **Bump**: `bun scripts/bump-aztec.ts <version>` → review sweep + supply-chain report (mechanical rules: zero NOT-PUBLISHED / provenance regressions on resolved alias-aware pairs) → `./scripts/verify-nargo-refs.sh --write` + commit the lock → `bun install` → `bun scripts/bump-aztec.ts --regenerate-excludes` → full local validation → PR → gates green → squash-merge.
2. **Rehearse** (main HEAD = the merge commit, note its `<sha>`): dispatch `release.yml` `mode=rehearsal` `version=0.0.0-canary.g<sha7>` (must name THIS commit — validated). Runs the ENTIRE production path: overlay → build → fail-closed tarball assertions → OIDC publish with provenance → identity assertions → tag + prerelease notes. Publishes immutable junk versions (by design; precedented). Then **re-dispatch the exact same inputs** — the recovery drill: preflight must accept via dist.integrity + attestation-identity checks and finish without changing the registry. Clean up the junk tag/GH prerelease after (`git push --delete origin v0.0.0-canary.g<sha7>` + `gh release delete`).
3. **Release** (main HEAD unchanged — the workflow enforces it): dispatch `release.yml` `mode=release` `version=<version>` `expected-head-sha=<full sha>` `compare-against=0.0.0-canary.g<sha7>`. All four inputs are REQUIRED in release mode — a bare dispatch fails validation. The workflow additionally:
   - re-runs full validation in-workflow (TXE with count floors + typecheck + integration + benchmark build) — never trusts a prior PR run,
   - builds in a job WITHOUT publish credentials, hands sha256-manifested tarballs to a minimal OIDC publish job (full-SHA-pinned actions, exact-pinned npm),
   - authenticates the rehearsal baseline (dist.integrity + attestation identity) and **byte-compares the payload** (normalized tar entries: path/type/mode/link/digest) against it,
   - fresh runs require ALL THREE versions absent; recovery re-runs accept only integrity- and identity-verified prior publishes,
   - derives the dist-tag from the prerelease segment (stable → `latest`; `-rc.N` → `rc`; `-revision.N` → `revision`),
   - asserts published versions + dist-tags + registry integrity vs the built tarballs + **attestation identity** (repo/workflow/commit parsed from the Sigstore-verified provenance bundle — presence is not enough),
   - tags `v<version>` + creates/edits the GitHub release idempotently with notes rendered BEFORE publish.
4. **Hotfix path** (emergency only, decision A2/D18): fixes to an already-published lockstep version ship as `<aztecVersion>-revision.N` via `mode=hotfix` (same overlay + binding rules as release, rehearse first). They land under the `revision` dist-tag; moving `latest` is the manual OTP step below. Semver caveats (documented deliberately): `-revision.N` sorts BELOW the base version and `^`-ranges won't auto-match it — lockstep consumers install exact versions, and `latest` is moved by hand.

### One-time publishing bootstrap (COMPLETED 2026-07-02 — kept for reference / future scopes)

1. Before the first publish: create a **scope-level** granular npm automation token (publish, ≤30-day expiry, "Bypass 2FA" ticked), store as `NPM_TOKEN` in the protected GitHub environment `npm-publish`.
2. First-publish the package names once with that token. Do this as a TIGHTLY-SCOPED disposable procedure, never a lasting workflow: on a short-lived branch, add `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to release.yml's publish step, dispatch ONE `mode=rehearsal` run from that branch ref, then delete the branch AND revoke the token in the same sitting (the deletion/revocation steps are part of the procedure, not cleanup afterthoughts). npm trusted publishing cannot create a first version (npm/cli#8544) — this is the only moment a token exists.
3. On npmjs.com, configure a trusted publisher per package: repo, workflow `release.yml`, environment `npm-publish`, allowed action `npm publish`.
4. Revoke the bootstrap token — all subsequent publishing is tokenless. *(Executed for @alejoamiras; repeat only if the packages move to a new scope, e.g. aztec-network. The repo no longer references `NPM_TOKEN` anywhere.)*

## Empirical registry findings (2026-07-02, learned during the rc.2 release)

- **`latest` cannot be deleted** (registry returns E400 on DELETE) — only moved. Policy: `latest` tracks the newest REAL release (rc now, stable later); canaries must never hold it.
- **Trusted-publishing OIDC credentials authorize `npm publish` ONLY** (allowed-actions lockdown): `npm dist-tag` in CI gets E401 by design. Dist-tag maintenance is a manual step with interactive 2FA: `npm dist-tag add @alejoamiras/<pkg>@<version> latest --otp=<code>` (or the browser-auth flow).
- **First-publish sets `latest`** regardless of `--tag` (settled a docs-vs-field dispute between our two audit models — the field was right).
- npm read-API propagation after a first publish can exceed 10 minutes — all CI assertions retry accordingly.
- With package setting "Require 2FA and disallow tokens", even the owner's session token cannot mutate dist-tags — expect the web-auth/OTP dance.
- **Attestation identity, not just presence** (added at 5.0.0): `scripts/verify-attestation-identity.sh <pkg> <version> [sha]` = `npm audit signatures` on a clean install (Sigstore verification bound to the package digest) + repo/workflow/commit assertions parsed from the registry provenance bundle. Recovery paths refuse artifacts that fail either layer.

## Local notes

- `bun run lint` / `lint:actions` before pushing workflow changes.
- Local TXE runs (`aztec test`) MUST NOT overlap a running local network on the same machine — LMDB (`mdb_txn_begin: 22`) flakes roam across packages otherwise (macOS; see lessons/phase-3.md). CI is unaffected (separate runners).
- Integration tests expect the local network on :8080 (`NODE_URL` override) and L1 anvil on :8545 (`L1_RPC_URL` override, fee-payment).
