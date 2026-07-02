# wonderland-consolidation — plan.md

**Tier**: `/blueprint mid` · **Created**: 2026-07-01 · **Status**: **APPROVED 2026-07-01** (verdict: Approve; A6=peerDeps-exact, A7=non-vacuous report gate, A5=harden deferred/decide-later) · implementing
**Repo**: `ecosystem-tooling` (github.com/alejoamiras/ecosystem-tooling, to be created)
**Driver**: defi-wonderland's contract is ending; Aztec ecosystem lead takes over their packages. Immediate deliverable: all packages consolidated into one bun monorepo AND released at Aztec **v5.0.0-rc.2** under a new npm scope.

---

## 1. Context (research 2026-07-01; corrected per round-1 audits)

Three source repos, all `dev`-default, clean, in sync with origin, pinned to Aztec `5.0.0-rc.1`, Yarn-classic + Prettier + Husky, MIT (© Wonderland):

| Repo (local clone under `~/Projects/Ecosystem/`) | Ships | npm today | Notes |
|---|---|---|---|
| `aztec-standards` | 7 Noir contracts + generated TS bindings, one npm package | `@defi-wonderland/aztec-standards` — stuck at 4.2.0, no 5.x | 329 Noir TXE tests; 29 vitest integration cases (local network :8080). Published package has **no `exports`/`main`** — consumers deep-import `artifacts/*`, `dist/*`, `target/*`, `deployments.json`. |
| `aztec-fee-payment` | PrivateFPC + fpc_lib + Counter + TS SDK | **never published** (root `private:true`; 3 conflicting names: `aztec-fee-payment` / `@wonderland/…` / `@defi-wonderland/…`) | 11 active TXE tests (7 disabled — TXE limits); pay_fee/mint covered ONLY by 3 vitest integration tests (need L1 anvil :8545 + FeeJuice bridging). Has PRD + spec-guardian CLAUDE.md. |
| `aztec-benchmark` | Benchmark CLI (npm) + GitHub Action + 2 reusable workflows | `@defi-wonderland/aztec-benchmark` — 5.0.0-rc.1 under `rc`; `latest`=4.3.0 | Consumed by the other two as npm dep AND cross-repo reusable workflows (`@4.2.0`/`@4.3.0`). tsc+ncc; no tests. |

**Publishing reality (audit-critical):** today's packages are assembled by `scripts/build-package.sh`, whose `jq` step **strips all `scripts` and ALL `dependencies`** before publish — the published artifacts have zero lifecycle scripts and zero deps (consumers bring their own `@aztec/*`). Publishing from package dirs without curation would ship `postinstall: husky` (breaks every npm consumer) and standards' benchmark entry, which sits in **`dependencies`** (package.json:37), dragging the CLI + `typescript`/`esbuild`/`tsx` into consumer installs.

**Cross-cutting facts:**

- **Wonderland's open rc.2 PRs, live CI state (checked 2026-07-01):** standards#358 **all checks green** (JS/Noir/Benchmark/Pre-Release) — shows the rc.2 rename pattern (`AztecAddress.fromBigInt` → `fromBigIntUnsafe`); fee-payment#166 JS+Noir green but **Benchmark job FAILED** (`TypeError: AztecAddress.fromString is not a function`, `benchmarks/private.benchmark.ts:127` — call sites 127/163/210; diff touches zero .ts files → bump-only, incomplete); benchmark#95 **no test CI at all** (CodeQL only). Trust tiers: standards diff CI-proven; fee-payment diff incomplete; benchmark diff unvalidated.
- **External CI dies with the fork**: all three delegate to `defi-wonderland/aztec-ci-actions@v0` — `setup-aztec` (reads `config.aztecVersion` from root package.json → installs via `install.aztec.network` + `aztec-up install`, caches `~/.aztec`, foundry pinned v1.4.1), `run-tests.yml` (runner `ubuntu-latest-m`; **both** noir and js jobs run under a `script -e -c` PTY wrapper; `BASE_PXE_URL` is set but consumed by nothing — vestigial), `pre-release.yml` (GH prereleases + tarballs, no npm).
- **Versioning convention**: package version == Aztec version (lockstep). `@aztec/*@5.0.0-rc.2` published 2026-06-29 (~2 days old; no dist-tag points at it; **~30–31 distinct `@aztec/*` packages** in each lockfile incl. transitives like `bb.js`, `native`, `kv-store`).
- **npm trusted publishing cannot do a first-ever publish** (npm/cli#8544) and **requires GitHub-hosted runners** — publish jobs can never move to self-hosted. OIDC publish needs npm CLI ≥ 11.5.x (Wonderland's own publish.yml has an explicit `npm install -g npm@11.5.2` step).

### Phase 0 answers (user, 2026-07-01)

1. **Done** = monorepo + CI green + **v5.0.0-rc.2 published to npm** from the new pipeline.
2. **Benchmark migrates EARLY.**
3. **Fresh git history** (snapshot import + attribution).
4. **Gates**: TXE + TS integration + canary publish e2e + benchmarks as gates (see A7 for what "benchmark gate" can honestly mean today).
5. Production quality bar.

---

## 2. Target architecture

```
ecosystem-tooling/
├── packages/
│   ├── aztec-benchmark/        # @alejoamiras/aztec-benchmark   (CLI + action/ + comparison lib)
│   ├── aztec-standards/        # @alejoamiras/aztec-standards   (Noir contracts + TS bindings)
│   └── aztec-fee-payment/      # @alejoamiras/aztec-fee-payment (PrivateFPC + TS SDK + PRD docs)
├── .github/
│   ├── actions/setup-aztec/    # replaces aztec-ci-actions (hardened — see §4)
│   └── workflows/              # per-package gates, _reusables, actionlint, canary, release
├── scripts/                    # bump-aztec.ts, verify-tarball.ts
├── implementations-plan/  ├── docs/  ├── CLAUDE.md, README.md, LICENSE
├── biome.json, bunfig.toml, commitlint.config.ts, .husky/
└── package.json                # private root, workspaces: ["packages/*"], bun
```

**Key decisions** (rationale in §7 ledger):

- **npm scope `@alejoamiras`**, base names preserved. Scope changes again on aztec-network transfer — accepted future break.
- **Lockstep versioning** (== Aztec version). **Internal cross-package deps use exact lockstep pins, NOT `workspace:*`** — npm CLI (required for OIDC/provenance publish) publishes the workspace protocol string verbatim; bun links workspace members whose versions match anyway (D14).
- **Published-manifest curation** (D15, new phase step in every import): strip `postinstall`/`prepare` husky + `packageManager` + `engines.yarn`; benchmark → `devDependencies`; `@aztec/*` imported by shipped code → **`peerDependencies`** (exact lockstep version — declares the real contract; today's zero-dep tarballs made it implicit); test-only imports stay devDeps; **undeclared direct imports get declared** (`@aztec/bb.js`, `@aztec/l1-artifacts`, etc.); `repository`/`homepage`/`bugs` → new repo (**provenance validates `repository` — publish fails otherwise**); `files` + `exports` maps preserving the FULL legacy surface: `./artifacts/*`, `./dist/*` (kept as a compat mirror for rc.2, deprecated at stable), `./target/*`, `deployments.json` at package root.
- **bun replaces yarn**; **vitest kept** (forks/singleFork pool + `server.deps.inline` + noble alias are load-bearing); **tsx kept** for benchmark bin. Fee-payment's noble alias switches to `require.resolve`-based (its current literal `node_modules` path dies under workspace hoisting) and its yarn `resolutions` move to the monorepo root.
- **biome replaces prettier** (120/single-quote/2-space to match standards/benchmark; fee-payment used prettier defaults → full reformat, isolated in its import commit). `noExplicitAny: error` at root with **per-package overrides (warn)** for imported code + debt item.
- **`main`-only branching**; releases via `workflow_dispatch`. Branch protection uses always-triggering gate workflows with internal `changes` path-filter jobs (trigger-level `paths:` would deadlock required checks).
- **Supply chain**: `minimumReleaseAge = 604800` with `@aztec/*` exclusions — the exclusion list is **generated from the lockfile by `bump-aztec.ts`** (30+ packages; hand-lists rot). `bun.lock` committed; CI `--frozen-lockfile`; `bun pm untrusted` audit + explicit `trustedDependencies` allowlist (lmdb/leveldown/msgpackr-extract/@aztec-native class packages).
- **Publishing**: bootstrap canary via **scope-level** granular token (packages don't exist yet — a package-scoped token is impossible; short expiry, GH environment `npm-publish` with protection rules), then trusted publisher ×3, then rc.2 via OIDC + `--provenance`, token revoked. **Publish order: benchmark → standards/fee-payment** (deps must resolve). Canary versions: `0.0.0-canary.<sha>` (all-digit shas make `0.0.0-<sha>` invalid semver). Post-publish assertions on dist-tags (see gates).
- Per-package **Nargo workspaces stay per-package**; nested `test_logic_contract` relative paths survive because each package tree moves intact.
- Wonderland's GH-prerelease-tarball flow not replicated; npm canary replaces it. `aztec inspect-contract` sanity step from `build-package.sh` is re-added to package build scripts (silently dropping it loses a check).

---

## 3. Phases

> Retry policy: human-driven — reassess after 3 failures on a step; `/loop` autonomous — after 5. Lessons in `lessons/phase-N.md`.

### Phase 1 ✓ — Repo bootstrap & skeleton (gate FULLY green 2026-07-01: install/lint/actionlint/hooks/min-age checks ✓; npm preflight complete — `npm whoami` → alejoamiras ✓, all three names free ✓. Repo live: github.com/alejoamiras/ecosystem-tooling. I3 resolved FALSE empirically — lessons/phase-1.md)

- `git init` (`main`), `gh repo create alejoamiras/ecosystem-tooling --public`.
- Root package.json (private, workspaces, engines node ≥22), bunfig.toml (min-age 7d + generated `@aztec/*` exclusions — **verify glob support empirically; else enumerate from lockfile**), biome.json (+ per-package override scaffolding), commitlint.config.ts, husky (pre-commit: lint-staged incl. `*.nr` → per-package-cwd `aztec-nargo fmt`; commit-msg: commitlint), lint-staged, sort-package-json, tsconfig.base.json, root scripts (`lint`, `lint:actions`, `test:nr`, `test:js`, `compile`, `codegen`, `bench` fan-outs).
- README attribution block (forked-from + SHAs + MIT), root LICENSE (own line + "portions © 2024–2025 Wonderland"), CLAUDE.md + docs skeletons, .gitignore.
- CI seed: `actionlint.yml`.
- **npm preflight**: `npm whoami` == alejoamiras (username scope publishable); `npm view @alejoamiras/aztec-standards` etc. → 404 (names free).

**Gate**: `bun install` · `bun run lint` · `bun run lint:actions` · hooks fire on scratch commit (bad message rejected) · npm preflight passes · bunfig min-age behavior verified (`bun add` of a <7-day package fails; an excluded `@aztec/*` installs). Layers: lint.

### Phase 2 ✓ — Import `aztec-benchmark` (gate green 2026-07-01: build+ncc ✓, CLI smoke ✓, lint ✓, actionlint ✓, untrusted-audit 0; TS2742 isolated-linker fix logged in lessons/phase-2.md; setup-aztec action pulled forward from Phase 5)

- Snapshot `dev` (`0c68996`) → `packages/aztec-benchmark/` (keep its LICENSE).
- Manifest curation per D15 (name `@alejoamiras/aztec-benchmark`, version stays 5.0.0-rc.1 until Phase 6, repository fields, strip husky/packageManager, keep `files`, bin via tsx).
- Scripts to bun; keep `tsc && ncc build`; biome (its 9 `: any` sites → package override warn + debt note).
- **Vendor reusable workflows** → `_pr-benchmark.yml` + `_update-baseline.yml` with the full adaptation list: per-package `working-directory`; **baseline artifact names namespaced per package** (`benchmark-baseline-<pkg>-<branch>` — they collide otherwise); workflow-name inputs updated to the new per-package filenames; `if: github.event_name == 'pull_request'` guards (dispatch bypass leaves `github.event.pull_request.*` empty); **execution/comment job split** (benchmark job: read-only, uploads markdown artifact; comment job: `pull-requests: write`, never executes PR code); fork-PR guard on the comment step; `require('@defi-wonderland/aztec-benchmark/...')` → new scope; **benchmark steps assert non-vacuous results** (comparison.cjs returns happy markdown for zero matching pairs — gate on non-empty benchmark JSON + successful baseline download + ≥1 comparison pair); action pinning per §4 policy (all non-`actions/*` full-SHA).
- `bun pm untrusted` review → root `trustedDependencies` if needed.

**Gate**: `bun run --cwd packages/aztec-benchmark build` (dist + action/dist emitted) · CLI smoke `--help` · `bun run lint` · `bun run lint:actions` · `bun pm untrusted` reviewed (allowlist committed if non-empty). Layers: lint + build/smoke (repo has no tests — noted).

### Phase 3 ✓ — Import `aztec-standards` (gate green 2026-07-01: compile/codegen ✓, build ✓, TXE **329/329** ✓, vitest **29/29** ✓, bench 5/5 non-empty ✓, lint ✓, CI spike ALL GREEN on ubuntu-latest — setup 238s / TXE 539s / 1 integration test 58s → **I1 confirmed**. Lessons: lessons/phase-3.md)

- Snapshot `dev` (`1cade05`) → `packages/aztec-standards/` (Nargo workspace + nested member intact; `src/deployments.json` kept).
- Manifest curation per D15: name/repository; **`@aztec/*` → peerDependencies (exact)**; benchmark → devDependencies (exact lockstep pin); declare undeclared direct imports; `files`+`exports` covering `./artifacts/*`, `./dist/*` mirror, `./target/*`, `./deployments.json` (copied to package root at build); strip husky.
- Replace `build-package.sh` with tsconfig.build.json build + `aztec inspect-contract` step; scripts to bun; biome; vitest config untouched (already `require.resolve`-based).
- Fix stale `compiler_version = ">=0.25.0"` in generic_proxy.
- **CI capacity spike** (I1): temporary `spike-ci.yml` (dispatch): setup-aztec composite (minimal) + `aztec start --local-network` + TXE run + 1 js test on `ubuntu-latest`; record timings in lessons/phase-3.md. Deleted in Phase 5.

**Gate** (local network running): `compile` + `codegen` clean · `aztec test` **329 green** · `test:js` **29 green** · `bench` completes + report generated · `bun run lint` · spike workflow: green on ubuntu-latest with recorded timings (or I1 fallback decision logged). Layers: lint + TXE + integration + bench + CI spike.

### Phase 4 ✓ — Import `aztec-fee-payment` (gate green 2026-07-01: TXE **11/11** ✓, vitest **11/11** ✓ incl. L1 bridge + reverts, **isolation proof 3/3 vs relocated sandbox :18080** ✓, bench ✓, lint ✓. Lessons: lessons/phase-4.md)

- Snapshot `dev` (`def90aa`) → `packages/aztec-fee-payment/`.
- Canonical name `@alejoamiras/aztec-fee-payment`; manifest curation per D15 (drop `private`, repository fields, `@aztec/*` runtime imports → peerDeps, declare `@aztec/bb.js`/`l1-artifacts` where shipped code imports them, keep exports+files).
- **vitest fixes** (config is NOT untouched): noble alias → `require.resolve`; `resolutions` → root (bun `overrides`); keep forks/singleFork/inline-deps.
- **Env centralization**: single resolver used by tests, harness, benchmarks — `NODE_URL` (kills the `LOCAL_AZTEC_NODE_URL` drift), `L1_RPC_URL` (harness.ts:205 hardcode), benchmark default unified.
- PRD + spec-guardian CLAUDE.md carried, stale v4.2.0 references fixed; docs name → new scope.
- Biome full reformat (prettier-defaults package) isolated in the import commit.

**Gate** (local network running): `aztec test` **11 green** · `test:js` **11 green** (8 unit + 3 integration incl. L1 bridge + revert paths) · **one integration re-run with non-default `NODE_URL`/`L1_RPC_URL`** against a relocated sandbox (proves env seam) · `benchmark` completes · `bun run lint`. Layers: lint + TXE + integration(+L1) + bench + isolation seam.

### Phase 5 — CI pipeline + canary publish e2e

- `.github/actions/setup-aztec` (composite, hardened): setup-bun + `bun install --frozen-lockfile`; setup-node 24; foundry-toolchain@v1 (v1.4.1); cache `~/.aztec` by version; **version from root `config.aztecVersion`, regex-validated (`^[0-9A-Za-z.+-]+$`), passed via env, quoted everywhere; `curl --fail --proto '=https' --tlsv1.2`**; inputs `start-local-network`/`run-compile`/`run-codegen`/`working-directory`; :8080 readiness poll.
- `_package-checks.yml` (reusable): noir-tests + js-tests jobs, **both PTY-wrapped** (`script -e -c`), per-package working-directory; bench via `_pr-benchmark.yml`.
- Per-package gates (`aztec-standards.yml` / `aztec-fee-payment.yml` / `aztec-benchmark.yml`): internal `changes` job (dorny/paths-filter; own tree + deps' src + shared config + own/reusable workflow files + actions; dispatch bypass). Runner `ubuntu-latest` (validated by Phase 3 spike). PR benches run with **`--skip-proving`** (CLI's designed degraded mode); full-proving benches on main via `_update-baseline.yml`.
- `actionlint.yml`; `bun audit` advisory.
- `canary.yml` (dispatch): versions `0.0.0-canary.<sha>`, internal deps rewritten to match, **`npm publish --tag canary`** ×3 (benchmark first) using bootstrap token (env `npm-publish`, protection rules + reviewers).
- `release.yml` (dispatch, `version` input, main only): validate input == all package versions & == `config.aztecVersion` → **re-run full validation on the exact release sha IN-WORKFLOW before any publish** (lint + TXE + integration + bench, plus `npm pack` ×3 and `scripts/verify-tarball.ts` against the packed tarballs — the release never trusts a prior PR run's transcript) → `npm install -g npm@^11.5.2 && npm -v` → publish ×3 benchmark-first, dist-tag from prerelease segment (`rc` / `latest`), `--provenance` → tag `v<version>` + GH release. Publish jobs: GitHub-hosted ONLY, `id-token: write` only there, **`environment: npm-publish`** (same protected environment as the bootstrap token; the npm trusted-publisher config binds to this environment name and selects allowed action `npm publish`).
- Default `permissions: contents: read` everywhere; write scopes per-job. Branch protection (always-trigger + changes-job pattern).
- Baseline seeding: dispatch `_update-baseline` on main (Phase 5 exit criterion — Phase 6 comparisons need rc.1 baselines).
- **Execute canary** → then USER: configure trusted publisher ×3 on npmjs.com; revoke bootstrap token.

**Gate**: actionlint 0 · PR exercising all three gates → `gh pr checks` all green · canary on npm: `npm view` shows `canary` dist-tag ×3 AND **`latest` absent/never `0.0.0-*`** · **npm-client install smoke**: `npm install` (not bun) of each canary in a temp dir + `scripts/verify-tarball.ts` imports every legacy subpath (artifacts/dist/target/deployments.json for standards; exports map for fee-payment; CLI + `action/comparison.cjs` for benchmark) · baselines seeded on main. Layers: lint + TXE + integration + bench (CI) + publish e2e + tarball compat.

### Phase 6 — Aztec 5.0.0-rc.2 bump + THE release

- `scripts/bump-aztec.ts`: sweeps root `config.aztecVersion`, every `@aztec/*` pin (deps/devDeps/peerDeps), package versions + internal exact pins (lockstep), every `Nargo.toml` `tag = "v<...>"`, PRD header; **regenerates the bunfig `@aztec/*` min-age exclusion list in two phases** (a new rc can add `@aztec/*` transitives absent from the old lockfile, deadlocking install: use the verified glob if bun supports it, else compute the new `@aztec/*` dependency closure from registry metadata BEFORE `bun install`, then regenerate the exact list from the fresh lockfile after); emits a supply-chain report (publish dates + provenance/attestation status of every bumped `@aztec/*` version) for the PR description.
- Run `bun scripts/bump-aztec.ts 5.0.0-rc.2` + `bun install`.
- Apply code fixes with trust tiers: standards — mirror #358 (CI-proven; `fromBigInt`→`fromBigIntUnsafe` pattern in test utils); fee-payment — #166 is bump-only and its benchmark job is RED: **pre-known task: fix `AztecAddress.fromString` call sites in `benchmarks/private.benchmark.ts:127,163,210`** (find rc.2 equivalent per #358's pattern) + re-check SDK surface; benchmark — #95 unvalidated: full local build + bench run required.
- Full local validation (Phases 3/4 gates re-run at rc.2) → PR → CI green → merge → dispatch `release.yml 5.0.0-rc.2`.

**Gate**: pre-merge: full suites green at rc.2 (TXE 329+11, integration 29+11, benches complete **with non-empty results + ≥1 comparison pair vs the rc.1 baseline**) · release workflow's OWN pre-publish validation green (D20) · post-release: `npm view @alejoamiras/<pkg>@5.0.0-rc.2` ×3 · `rc` dist-tag set, `latest` untouched · provenance attestations present (`npm view <pkg>@5.0.0-rc.2 --json | jq .dist.attestations`) · npm-client temp-dir install + `verify-tarball.ts` at rc.2 · supply-chain report attached to the release PR. Layers: everything + live npm release.

### Phase 7 — Docs & wrap

- README final (package table, attribution, **migration mapping** old→new incl. "no `latest` until stable is intentional" note), docs/ci-pipeline.md (workflow map + release runbook + trusted-publisher notes), docs/roadmap.md (deferred items §8), CLAUDE.md final, index.md updated; prune dead configs (coderabbit, dependabot, dead tsconfig excludes).

**Gate**: `bun run lint` + `lint:actions` + full `test:nr` + `test:js` green · docs reviewed against shipped state. Layers: lint + TXE + integration.

### Post-implementation (protocol, not a phase)

`/code-review max --fix` → separate commits → codex post-impl audit (net diff + code-review summary + plan + adversarial ask) → address high/critical → wrap-up report.

---

## 4. Security & Adversarial Considerations

**Threat model.** Assets: the npm packages (future ecosystem dependencies — a poisoned publish propagates), the Actions pipeline (publish rights), the contracts (NO logic changes in this plan — bump-only; fee-payment PRD spec-guardian preserved). Attackers: npm supply-chain worms, compromised upstream `@aztec/*` publishes, PR-based CI injection on a public repo, token theft, benchmark-baseline poisoning.

- **Supply chain**: min-age 7d for the long tail; `@aztec/*` excluded BY GENERATED LIST (30+ pkgs) — exposure is only at deliberate bump time, bounded by: exact pins (no ranges), committed lockfile + `--frozen-lockfile`, bump PRs carrying a generated supply-chain report (publish dates + provenance status per bumped package). `bun pm untrusted` + explicit `trustedDependencies` (bun blocks lifecycle scripts by default — silent native-module breakage otherwise). `bun audit` advisory.
- **Publishing**: trusted publisher + `--provenance` steady-state; GitHub-hosted runners only for publish jobs (OIDC requirement); npm CLI ≥11.5.x in publish jobs. Bootstrap: **scope-level** granular token (packages don't pre-exist), ≤30-day expiry, GH environment `npm-publish` with protection + reviewers, used for canary only, revoked after trusted-publisher config. Dist-tag hygiene enforced by post-publish assertions (canary never `latest`; rc under `rc`; `0.0.0-*` never `latest` — Wonderland's standards release.yml hardcoded `--tag latest`, fixed here). Publish order benchmark-first (no unresolvable-dep window).
- **CI injection**: `config.aztecVersion` regex-validated + env-passed + quoted; `curl --fail --proto '=https' --tlsv1.2`; release `version` input validated against package.json before any shell use; no `pull_request_target`; benchmark **execution job is read-only** — the `pull-requests: write` comment job consumes only the markdown artifact and never runs PR code; fork PRs: comment step guarded (no write token available). **Action pinning policy: `actions/*` may use major tags; EVERY other external action is full-SHA pinned** (oven-sh/setup-bun, foundry-rs/foundry-toolchain, dorny/paths-filter, dawidd6/action-download-artifact, peter-evans/create-or-update-comment, softprops equivalents — no exceptions for "well-known" creators). Known accepted risk while benches are report-only: dawidd6 baseline-poisoning via same-named fork branch → falsified PR benchmark numbers (documented; revisit if benches become numerically blocking).
- **Least privilege**: default `permissions: contents: read`; `id-token: write` publish jobs only; `contents: write` release-tag job only; `pull-requests: write` comment job only.
- **Cryptography**: nothing rolled ourselves; `aztec-nr`/noir-lang libs pinned by git tag; `@noble/*` pinned at root via overrides.
- **Contract-domain risks** (reorg/replay/front-running/reentrancy): unchanged — no contract edits; any rc.2 API fix touching `.nr` re-runs full TXE+integration and, for fee-payment, the PRD spec-guardian check.
- **Repo hygiene**: branch protection + required checks; no secrets in YAML; `.env.example` only.
- **Post-impl hardening**: `/harden security` recommended before first stable release or org transfer (A5).

---

## 5. Assumptions

### Facts (verified; corrections from round-1 audits applied)

- F1. All three repos pinned Aztec `5.0.0-rc.1` (package.json exact + Nargo.toml `tag = "v5.0.0-rc.1"`); bump surface ~23/~20/package.json-only locations. (Explore agents.)
- F2. npm: standards latest=4.2.0 (no 5.x); benchmark 5.0.0-rc.1 under `rc`, latest=4.3.0; fee-payment never published. (npm view 2026-07-01.)
- F3. rc.2 PRs open + **live CI**: #358 green; #166 benchmark job RED (`AztecAddress.fromString` ×3 in benchmarks/private.benchmark.ts), diff bump-only; #95 no test CI. (gh api + fable live check 2026-07-01.)
- F4. `@aztec/*@5.0.0-rc.2` published 2026-06-29T18:08Z; no dist-tag; **30–31 `@aztec/*` packages per lockfile** incl. transitives. (npm view; lockfiles.)
- F5. aztec-ci-actions mapped: setup-aztec version source `config.aztecVersion` (root), install.aztec.network + `aztec-up install`, `~/.aztec` cache, foundry v1.4.1; run-tests runner `ubuntu-latest-m`; **PTY wrapper on BOTH noir and js jobs**; `BASE_PXE_URL` vestigial (nothing consumes it); pre-release = GH prerelease + tarballs. (Clone.)
- F6. Trusted publishing: no first-publish (npm/cli#8544); GitHub-hosted runners only; **npm CLI ≥11.5.1 + Node ≥22.14**; trusted-publisher configs created after 2026-05-20 must also select **"allowed actions"** (we select `npm publish`) and can bind to a GitHub **environment** (we bind `npm-publish`). (docs.npmjs.com/trusted-publishers, checked 2026-07-01.)
- F7. Local clones == origin/dev, clean. (git, 2026-07-01.)
- F8 (corrected during Phase 6 verify-tarball). Published standards package has no entry points; tarballs ship `artifacts/` + `dist/` + `target/` + `deployments.json`, NO scripts/deps. **Correction (2026-07-01, legacy 4.2.0 tarball inspected): the compiled layout is NESTED — `artifacts/src/artifacts/*.js` and `dist/src/artifacts/*.js` (tsc rootDir widening), plus `artifacts/target/*.json`** — not flat `artifacts/*.js` as originally reported. Our build reproduces the nested layout byte-for-byte; verify-tarball encodes the real paths; the `./artifacts/*` exports pattern covers nested subpaths.
- F9 (corrected). Benchmark is a runtime **`dependency` of standards** (package.json:37) — must become devDep at curation; devDep in fee-payment.
- F10. fee-payment pay_fee/mint covered only by 3 TS integration tests; 7 TXE tests disabled with BLOCKED comments.
- F11. standards' `postinstall: husky` (package.json:12) would run on consumer installs if published uncurated; bun-only smoke tests mask it (bun blocks untrusted postinstalls).
- F12. fee-payment vitest noble alias is a literal package-local `node_modules` path (vitest.config.ts:7-10; dies under hoisting); its `@noble/hashes` pin lives in root-only-semantics yarn `resolutions` (package.json:85-87). standards' equivalent uses `require.resolve` (survives).
- F13. benchmark CLI has `--skip-proving` (cli/cli.ts) — designed degraded mode for PR benches.
- F14. `action/comparison.cjs` produces report markdown only — **no exit-code/threshold mechanism anywhere** ("blocking benchmarks" cannot mean numeric regression-blocking today).

### Inferences (unverified — with mitigations)

- I1. **ubuntu-latest can run local network + suites.** Sharpened: Phase 3 spike proves/kills it early; PR benches use `--skip-proving`; publish jobs are exempt from any fallback (must stay GitHub-hosted). Fallback ladder for TEST jobs only: split js jobs per package → GH Team larger runners → self-hosted for tests only.
- I3. bunfig `minimumReleaseAgeExcludes` glob support unknown → **treated as load-bearing**: Phase 1 gate verifies empirically; generated enumeration is the fallback either way.
- I5. biome≈prettier parity holds for standards/benchmark only; fee-payment reformats fully (isolated commit); `noExplicitAny` scoped per-package (M8).
- I6. aztec CLI rc.2 installs via same mechanism (their action builds `install.aztec.network/<v>/` URLs; rc.2 GH prereleases exist) — verified cheaply in Phase 3 spike.
- I8. PTY wrapper carried to both jobs; harmless if unnecessary.
- (I2 removed — decision D14 made it moot. I4 removed — replaced by F3 evidence + trust tiers. I7 removed — now a Phase 1 gate check.)

### Asks (decisions for the user at approval)

- A1. Repo public from day 1 (provenance requires it; all MIT). Assumed YES.
- A2 (rewritten). Your two npm-web-UI steps: (1) before Phase 5 canary — create a **scope-level** granular automation token (`@alejoamiras`, publish rights, ≤30-day expiry; package-scoped is impossible pre-creation), store as secret in protected GH environment `npm-publish` (add yourself as required reviewer); (2) after canary — configure trusted publisher ×3 (repo `alejoamiras/ecosystem-tooling`, workflow `release.yml`, **environment `npm-publish`, allowed action `npm publish`**), then revoke the token.
- A3. Package base names unchanged. Assumed YES.
- A4. Dependabot + CodeRabbit dropped (manual ncu; own review). Assumed YES.
- A5. **RESOLVED (approval 2026-07-01): skip for now / decide later** — revisit at stable release or org transfer.
- A6. **RESOLVED (approval 2026-07-01): `@aztec/*` → peerDependencies (exact)** in published manifests. D18 → decided.
- A7. **RESOLVED (approval 2026-07-01): non-vacuous report gate** (ran + non-empty results + baseline downloaded + ≥1 comparison pair + report reviewed); numeric `--fail-on-regression` = roadmap. D17 → decided.
- A8. Recommendation delivered at gate (user action, outside plan execution): ask Wonderland to `npm deprecate` old-scope packages pointing at `@alejoamiras/*` once rc.2 ships — only possible while their contract lives.

---

## 6. Competing outline B — "release-first, restructure-later" (considered, not chosen)

Fork all three repos nearly as-is (yarn, prettier, their workflow shapes, vendored aztec-ci-actions), rename scopes + minimal publish plumbing, ship rc.2 within days, then bunify/restructure incrementally.

**Honest assessment (post-audit):** B does NOT dodge the dominant risks — the vendored-verbatim workflows reference `ubuntu-latest-m` (nonexistent on a personal account: B's first CI run queues forever until the same runner surgery A does), the `aztec-ci-actions@v0` cross-repo refs die with the fork either way, and B could bootstrap trusted publishing exactly like A (the earlier "B ships un-hardened" argument was a strawman — struck). The strongest pro-A evidence: fee-payment#166's red benchmark job IS the cross-repo version-skew disease (benchmark CLI at rc.1 vs host at rc.2) that A's single-lockfile lockstep monorepo structurally eliminates.

**B wins if**: a hard external deadline (<~1 week) lands for rc.2-on-npm; or a bun-toolchain blocker (M3-class) burns >2 days in Phases 3/4; or the I1 ladder exhausts. These are the explicit fallback triggers (D1).

---

## 7. Decision ledger

| # | Decision | Rejected | Why | Status |
|---|---|---|---|---|
| D1 | Outline A (migrate-then-release); B = fallback with explicit triggers: hard <1wk deadline, bun blocker >2 days in P3/P4, I1 ladder exhausted | B primary | B inherits the same CI surgery (ubuntu-latest-m + dead external refs) without the lockstep-monorepo payoff; #166's skew failure is the pro-A exhibit | decided (amended per audits) |
| D2 | Fresh history, snapshot + attribution | history merge | user decision | decided (user) |
| D3 | Benchmark first | last / separate | npm-dep + workflow coupling; rc.2 of their package may never ship | decided (user) |
| D4 | Lockstep version == Aztec version | changesets | consumers select by Aztec compat; revisit at stable | decided |
| D5 | Keep vitest (+ fee-payment alias/resolutions fixes per F12) | bun:test rewrite | load-bearing ESM machinery; fixes are surgical | decided (amended) |
| D6 | main-only branching | dev/main | single maintainer; canary replaces dev snapshots | decided |
| D7 | Publish from package dirs + **manifest curation step** + full legacy-surface exports (artifacts/dist-mirror/target/deployments.json) + inspect-contract re-added | uncurated dir publish; export/-assembly; clean-break paths | uncurated publish ships postinstall+deps breakage (C1); mirror keeps consumer migration = scope swap | decided (amended) |
| D8 | Trusted publisher + provenance; scope-level bootstrap token, env-protected, revoked | long-lived NPM_TOKEN | npm/cli#8544; package-scoped token impossible pre-creation | decided (amended) |
| D9 | min-age 7d + **lockfile-generated** `@aztec/*` exclusions + bump-time supply-chain report | hand-list (~30 pkgs, rots); no min-age | rc cadence vs gate; bounded residual | decided (amended) |
| D10 | Drop dependabot + coderabbit | keep | manual ncu per my-stack | decided |
| D11 | tsx stays for benchmark bin | bun shebang | consumers run node | decided |
| D12 | Benchmark consumption surface = reusable workflows + npm pkg; action/dist uncommitted | commit action/dist | no direct `uses:` consumers known | decided |
| D13 | Test-job runner ubuntu-latest, proven by Phase 3 spike; `--skip-proving` PR benches; **publish jobs GitHub-hosted always** | self-hosted publish | trusted publishing forbids self-hosted | decided (amended) |
| D14 | Internal deps: exact lockstep pins, no `workspace:*` | workspace protocol | npm CLI (OIDC path) publishes the protocol string verbatim | decided (new, from audits) |
| D15 | Published-manifest curation checklist (scripts/deps/peers/repository/files/exports) in every import phase | trust package dirs as-is | legacy jq stripped everything; uncurated = broken consumers (C1/H3) | decided (new) |
| D16 | Canary format `0.0.0-canary.<sha>` + post-publish dist-tag assertions | `0.0.0-<sha>` | all-digit sha = invalid semver; assertions make hygiene a gate | decided (new) |
| D17 | Bench gates = completes + report + **non-vacuous assertions** (non-empty results JSON, baseline downloaded, ≥1 comparison pair); numeric blocking = roadmap (pending A7) | pretend report-only tool blocks; vacuous "ran fine" gates | F14 + final-pass finding: comparison.cjs succeeds on zero pairs | recommended (A7 pending) |
| D18 | `@aztec/*` → peerDependencies exact in published manifests | zero-dep tarballs (status quo); hard `dependencies` | declares real contract; avoids duplicate-aztec class-identity bugs | recommended (A6 pending) |
| D19 | Keep Phase 1 hook/lint tooling + fee-payment reformat in-plan; PRE-DECLARED CUTS under timeline pressure: fee-payment biome reformat, noExplicitAny debt work, docs polish (final codex suggested deferring them; rejected as defaults because they're cheap and front-loaded, adopted as the official cut list) | cut them now | one command each; splitting hygiene across later PRs costs more than it saves — unless rc.2 timeline pressure hits | decided |
| D20 | release.yml re-validates the exact release sha in-workflow (full suites + pack + verify-tarball) BEFORE publish | trust prior PR-run transcripts | final codex critical: release could publish an unproven artifact | decided (new) |
| D21 | Trusted publisher bound to GH environment `npm-publish` + allowed action `npm publish`; publish jobs run in that environment | filename-only binding | OIDC path must be at least as protected as the bootstrap token path | decided (new) |
| D22 | Action pinning: `actions/*` major tags; ALL other external actions full-SHA | trust "verified creator" majors | final codex: policy had holes (setup-bun, foundry, paths-filter) | decided (new) |
| — | Gate outcomes 2026-07-01: **Approve**; A6 → peerDeps exact (D18 decided); A7 → non-vacuous report gate (D17 decided); A5 → harden deferred; A1/A3/A4 confirmed by silence at gate. Still open: I1 (Phase 3 spike), I3 (Phase 1 empirical check), A8 (user's external message to Wonderland) | | | resolved at gate |

---

## 8. Deferred (roadmap items, OUT of this plan)

Full run-isolation registry (`~/.agents` ports/agent.sh); `aztec-nightlies.yml`-style upstream tracking automation (auto-PR via bump-aztec.ts); aztec-network org transfer runbook; stable 5.0.0 release (revisit D4/D9/foundry pin/dist-mirror removal/`--fail-on-regression` calibration); `/harden security` (A5); benchmark numeric blocking thresholds.

---

## 9. Audit trail

- **Codex round 1** (session 019f1f7f-…ff14, xhigh): `conditional approve` — publish/tooling ambiguity, CI-injection hardening, write-job split, tarball/dist-tag gates, rc.2 de-risk, D1 amendment. All adopted; detail + disposition in `audit-codex.md`.
- **Fable round 1** (fresh-context Plan agent): `conditional approve` — manifest-curation C1 (postinstall/deps/peers/repository), live PR CI intel (#358 green / #166 bench RED / #95 unvalidated), vitest/resolutions fixes, generated exclusion list, benchmark-workflow adaptation list, report-only bench reality, A2 token-scope correction, D1 strawman strike. All adopted; detail in `audit-fable.md`. No inter-auditor contradictions; zero findings rejected.
- **Final fresh-context codex pass** (session 019f1f92-…71b7, xhigh, fresh): `conditional approve (with conditions: close the release/publish gates, harden OIDC environment binding, make benchmark gates non-empty, pin all third-party actions, and resolve A6/A7/A8 before kickoff)`. All conditions adopted → D20/D21/D22, D17 amended, two-phase exclusion fix, F6 updated, `npm@^11.5.2` spec fixed. Suggested cuts partially rejected → D19 (recorded as the official under-pressure cut list). Verdict on architecture: "the remaining issues are gate precision and release hardening, not architecture." Detail in `audit-codex.md`.

---

## 10. Seeds (FINAL — approved scope, 2026-07-01)

### Recommended: `/goal`

```
/goal All 7 phases marked ✓ in implementations-plan/wonderland-consolidation/plan.md (headers edited in the file), each ✓ backed by its validation-gate output in the transcript; per-phase LESSONS_FILE=implementations-plan/wonderland-consolidation/lessons/phase-N.md printed; canary AND v5.0.0-rc.2 verified via `npm view` output for all three @alejoamiras packages including dist-tag + attestation checks and the npm-client verify-tarball smoke; /code-review max --fix applied and committed; codex post-impl audit complete with high/critical addressed; `bun run lint` and full `bun run test:nr` exit 0 in the transcript.
```

### Alternative: `/loop 15m`

```
/loop 15m Drive implementations-plan/wonderland-consolidation forward. Never idle. Each firing: (1) read plan.md + lessons/ (authoritative), git status, git log -5; PR? gh pr view --json statusCheckRollup. (2) CI waits fine if progressing (gh run watch ≤10min); prep next phase meanwhile. (3) No task? Next pending plan.md step; after each meaningful edit run bun run lint + touched package's tests; commit → push. (4) Decision needed? /codex xhigh, decide, log in lessons/phase-N.md; hard limits: no publish/release without the phase gate met, no scope expansion, no force-push; the Phase 5 canary blocks on the user-created npm token (A2) — surface loudly, continue non-publish work. (5) Same step failed 5×? Stop, reassess with codex. (6) Phase gate green per plan.md? Paste result, mark ✓, print LESSONS_FILE=..., advance. (7) All ✓? /code-review max --fix → separate commits → codex post-impl audit → address high/critical → wrap-up report → stop.
```

**Use exactly ONE per session — they don't compose.**
