# Fable audit transcript — wonderland-consolidation

## Round 1 (blueprint mid step 3, dual audit) — 2026-07-01

- Auditor: independent Fable subagent (Plan type), fresh context, adversarial + assumption-attack asks. Verified against local clones, aztec-ci-actions clone, live npm, live GitHub PR CI state.

### Verdict

`conditional approve` — conditions are plan-text corrections, none re-architect Outline A:
1. Publish-manifest curation step in Phases 2–4 + publish-path repair (C1/H1/H3): strip `postinstall: husky`; benchmark → devDependencies in standards; explicit `@aztec/*` deps-vs-peerDeps decision; update `repository` fields (provenance validates them); exact pins instead of `workspace:*` (npm CLI publishes the protocol string verbatim); npm-client install smoke in canary/release gates.
2. Phase 6 updated with live upstream CI state: standards#358 all green; **fee-payment#166 benchmark job FAILED** (`AztecAddress.fromString is not a function`, benchmarks/private.benchmark.ts:127; call sites 127/163/210; their diff touches zero .ts files — bump-only, incomplete); benchmark#95 has no test CI. standards#358 shows the rc.2 rename pattern (`fromBigInt` → `fromBigIntUnsafe`). Budget the fee-payment benchmark fix; define benchmark-blocking semantics (comparison.cjs is report-only — no exit code anywhere).
3. Phase 4 "vitest config untouched" is wrong: fee-payment's noble alias hardcodes package-local `node_modules` (dies under hoisting; standards' `require.resolve` version survives); yarn `resolutions` are root-only — move to monorepo root.
4. min-age exclusion is 30–31 `@aztec/*` packages incl. transitives (not ~11); list must be lockfile-generated (by bump-aztec.ts), else every bump hard-fails install.
5. Pull I7 (scope ownership) into Phase 1 gate and an I1 CI-capacity spike into Phase 3; adopt benchmark CLI's existing `--skip-proving` as the designed I1 mitigation.

### Additional findings adopted

- M2: vendored benchmark-workflow adaptations enumerated (per-package working-directory; namespaced baseline artifacts — they collide across packages otherwise; workflow-name inputs; `pull_request`-only guards; baseline seeding on main as Phase 5 exit criterion).
- M3: `bun pm untrusted` review + `trustedDependencies` allowlist (leveldown/lmdb/msgpackr-extract/@aztec/native have install scripts).
- M4: A2's token instruction impossible as written — granular tokens can't target packages that don't exist; must be scope-level. I7 check belongs in Phase 1 (`@alejoamiras/aztec-standards` verified 404/free, but free ≠ owned scope).
- M5: legacy published surface is artifacts/* AND dist/* AND target/* AND deployments.json at package root; exports map covering only artifacts/target silently breaks dist-importers; `aztec inspect-contract` step dropped silently.
- M6: F9 misstated (benchmark is a runtime `dependency` of standards, package.json:37); F5 incomplete (PTY wrapper wraps noir tests too; `BASE_PXE_URL` is vestigial — nothing consumes it).
- M7: publish order must be benchmark-first or standards@rc.2 declares an unresolvable dep during the window.
- M8: `noExplicitAny: error` vs 9 existing `: any` sites — pick per-package overrides or code edits.
- M9: branch protection + paths-filter: gates must always trigger with internal `changes` job (skipped jobs satisfy protection); trigger-level `paths:` deadlocks PRs. Fork PRs lack `pull-requests: write` — guard the comment step.
- L1: `0.0.0-<shortsha>` invalid semver when sha is all-digits with leading zero → use `0.0.0-canary.<sha>`.
- L2: no `latest` tag until stable → document intentional behavior.
- L3: SHA-pin non-verified actions (dawidd6, peter-evans); note dawidd6 baseline-poisoning caveat (accepted risk while benchmarks are report-only).
- L4: fee-payment has NO .prettierrc (prettier defaults) → full-package reformat; isolate in import commit; I5 only holds for standards/benchmark.
- L5: strip `packageManager`/`engines.yarn` from imported manifests.
- L6: new Ask — Wonderland runs `npm deprecate` on old packages pointing to new scope (only possible before contract ends).

### Assumption attack summary

Facts: F9 misstated, F5 incomplete, "~11 packages" undercounted 3×, "CI status unknown" was queryable (now known). Everything else verified exactly (HEAD SHAs, 329 `#[test]`, 18 fee-payment TXE markers w/ BLOCKED, dist-tags, rc.2 publish timestamp, 3-name mess, stale compiler_version, nested test_logic_contract paths safe when tree moves intact, standards release.yml hardcodes `--tag latest`).
Inferences: I1 biggest open infra risk — spike + `--skip-proving`; I2 wrong for npm publish path; I3 load-bearing; I4 now evidence-based (trust tiers); I5 partial (M8/L4); I6 plausible — verify in spike; I7 → Phase 1 gate; I8 fine, extend to noir job.
Asks: A2 not executable as written; new Asks: peerDeps decision, benchmark-blocking semantics, Wonderland deprecation, runner budget.

### Outline A vs B

D1 verdict right; one leg strawman (B could bootstrap trusted publishing identically) and strongest pro-A argument missing: B doesn't dodge the dominant risks — vendored-verbatim workflows reference `ubuntu-latest-m` (nonexistent on personal accounts, B's first CI run queues forever) and cross-repo `aztec-ci-actions@v0` refs die with the fork either way; fee-payment#166's failure is the cross-repo version-skew disease A's lockstep monorepo structurally eliminates. B wins only under: hard <1-week external deadline; bun-toolchain blocker burning >2 days in Phases 3/4; or I1 ladder exhaustion.

### Top 5 (ranked)

1. Manifest curation + publish-path repair (C1+H1+H3+M7).
2. Phase 6 rewritten with live intel + benchmark-blocking semantics (H5+M1).
3. I7 → Phase 1 gate; I1 spike in Phase 3; `--skip-proving` for PR benches (M4).
4. Phase 4 migration list fixed: vitest noble path, root resolutions, vendored-workflow adaptations (H2+M2).
5. Executable supply-chain fallbacks: lockfile-generated exclusion list, `bun pm untrusted` audit (H4+M3).

### Disposition (main agent)

All conditions and findings adopted into plan.md v2 (see §7 ledger D14–D18 and §9 audit trail). No findings rejected. `@aztec/*` → peerDependencies adopted as recommendation, surfaced as approval Ask A6. Benchmark-blocking semantics surfaced as Ask A7 (recommendation: completes+report for now; numeric `--fail-on-regression` as roadmap).
