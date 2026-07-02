# Codex audit transcripts — wonderland-consolidation

## Round 1 (blueprint mid step 3, dual audit) — 2026-07-01

- Session: `019f1f7f-0abe-7200-b989-d39fee70ff14` · effort xhigh · sandbox read-only
- Prompt: full plan.md (Outline A + competing Outline B) + source-repo read access + adversarial/security ask + assumption-attack ask (I1–I8 targeted)

### Verdict

`conditional approve (with conditions: fix publish/tooling ambiguity, split CI write-token jobs from PR code, add tarball/dist-tag gates, de-risk rc.2 before release, and amend D1/B fallback triggers)`

### Findings (verbatim summary)

**Critical**
1. Publish path internally inconsistent: plan relies on bun rewriting `workspace:*` but publishes with `npm publish` (OIDC). npm CLI does not rewrite the workspace protocol. Fix: exact internal versions before publish + `npm pack` tarball smoke-install gate; publish with npm CLI only.
2. CI injection in vendored setup-aztec: `config.aztecVersion` read from PR-controlled package.json, interpolated unquoted into install commands (upstream action.yml:58,78). Fix: regex-validate version, pass via env, quote, `curl --fail --proto '=https' --tlsv1.2`.
3. Benchmark PR workflow runs untrusted PR code with `pull-requests: write` (upstream pr-benchmark.yml:39,59). Fix: read-only benchmark job → artifact → separate write-only comment job that never executes PR code.
4. Dist-tag hygiene not a real gate: Phase 5 only checks canary exists; accidental `bun publish` first-publish also sets `latest`. Fix: explicit `npm publish --tag canary` + post-publish assertion that `latest` is absent/never `0.0.0-*`.

**High**
5. Phase 6 under-de-risked given upstream rc.2 PRs unmerged/CI-unknown: add migration spike/gate with API-diff notes + full suites before publish.
6. Self-hosted runner fallback conflicts with npm trusted publishing (requires cloud-hosted runners). Publish jobs stay GitHub-hosted; only heavy validation may move.
7. min-age + `@aztec/*` exclusion partially defensible: enumerate packages, review lockfile integrity, verify npm timestamps/maintainers/provenance on bumps, log accepted risk.
8. Bun isolated installs may expose undeclared deps: standards imports `@aztec/bb.js`/`constants`/`foundation` not in its deps; fee-payment imports `@aztec/bb.js`/`l1-artifacts` (harness.ts:25) undeclared. Fix: declare all direct imports or hoisted-linker debt item.
9. Fee-payment run isolation incomplete: tests use `LOCAL_AZTEC_NODE_URL` (private.test.ts:32), harness hardcodes L1 (harness.ts:205), benchmark hardcodes default (private.benchmark.ts:37). Centralize env resolution; prove non-default ports.
10. Exports-map compatibility promised, not proven: add pre-publish tarball tests for every legacy deep import, `target/*.json`, fee-payment exports, benchmark CLI, `action/comparison.cjs`.

**Medium/Low**
11. `noExplicitAny: error` migration churn — scope after import.
12. Root husky must run `aztec-nargo fmt` per package cwd.
13. D1 honest but too narrow: B also wins if rc.2 deadline is hard, ubuntu-latest fails, trusted-publisher setup blocks, or restructuring obscures rc.2 API bugs.

**Assumption attack**: Facts F1/F5/F8/F9/F10 verified accurate (F7 unverifiable in read-only sandbox). Inferences: I1 unsafe; I2 misapplied (bun-only); I3 undocumented; I4 unsafe until validated; I5 unsafe w/ current `any`; I6 verify installer; I7 confirm pre-Phase 5; I8 prove in CI. New Asks: external benchmark-action compat, runner budget, npm environment reviewers, dist-tag cleanup authority, explicit B-fallback deadline.

**Top 5**: (1) exact internal deps + tarball smoke tests; (2) split PR-code jobs from write-token jobs; (3) validate version + harden installer exec; (4) rc.2 migration gate pre-release; (5) declare direct deps + non-default-port isolation proof.

**Looks fine**: benchmark-first order; per-package Nargo workspaces; keeping vitest; honest fee-payment coverage framing; dropping GH-prerelease tarball flow.

### Disposition (main agent)

All four Criticals adopted; High 5–10 adopted; Medium 11–12 adopted; 13 adopted (ledger amended). I2 rendered moot by dropping `workspace:*` in favor of exact lockstep pins (maintained by `scripts/bump-aztec.ts`). Full adopted/rejected log in plan.md §7 ledger + §9 audit trail.

---

## Final fresh-context pass (blueprint mid step 5) — 2026-07-01

- Session: `019f1f92-235f-7f81-8b3d-6b88de0571b7` · effort xhigh · sandbox read-only · NEW session (no round-1 context)
- Input: consolidated plan.md v2 + full decision ledger + round-1 transcripts + source repos; asked to attack the consolidation itself, re-run adversarial/security + assumption-attack, judge gate sufficiency for autonomous implementation, and identify over-engineering.

### Verdict

`conditional approve (with conditions: close the release/publish gates, harden OIDC environment binding, make benchmark gates non-empty, pin all third-party actions, and resolve A6/A7/A8 before kickoff)`

### Findings → dispositions

1. **Critical — release can publish without proving the exact artifact** (release.yml validated input then built+published; suites only pre-merge). ADOPTED → D20: release re-runs lint/TXE/integration/bench + `npm pack` + verify-tarball on the release sha in-workflow before any publish.
2. **High — trusted publishing less protected than the bootstrap token path** (env protection only on the token; OIDC bound by filename only). ADOPTED → D21: publish jobs in `environment: npm-publish`; trusted-publisher config binds that environment + allowed action `npm publish`.
3. **High — benchmark gates vacuously passable** (`runComparison()` returns happy markdown on zero pairs — action/comparison.cjs:352). ADOPTED → D17 amended: gates assert non-empty results JSON + baseline downloaded + ≥1 comparison pair.
4. **High — action-pinning policy incomplete** (only dawidd6/peter-evans named). ADOPTED → D22: `actions/*` majors; all other external actions full-SHA.
5. **Medium — A6/A7/A8 unresolved is fine for human approval, not autonomous run**. AGREED: resolved at the approval gate and written into §5/§7 before any /goal (its recommended defaults match ours: exact peerDeps, non-empty report-only bench gates, ask Wonderland to deprecate).
6. **Medium — exclusion regeneration deadlocks on NEW rc transitives** (list generated from old lockfile; install fails before new lockfile exists). ADOPTED: two-phase bump in Phase 6.
7. **Low — `npm@11.5.2+` not an executable spec**. ADOPTED: `npm install -g npm@^11.5.2 && npm -v`.
8. **F6 refresh**: npm CLI ≥11.5.1 / Node ≥22.14 / GitHub-hosted / "allowed actions" required for configs after 2026-05-20. ADOPTED.
9. **Cuts suggestion** (defer fee-payment reformat, noExplicitAny debt machinery, hook polish, docs skeleton): PARTIALLY REJECTED → D19. They're cheap and front-loaded; splitting hygiene into later PRs costs more. Recorded as the official cut list if rc.2 timeline pressure hits — codex's position preserved.
10. **What is now solid** (verbatim): benchmark-first, fresh history, exact internal pins, no workspace:* ambiguity, legacy tarball surface preservation, rc.2 trust tiers, fee-payment vitest/env fixes, Outline B fallback triggers — "the remaining issues are gate precision and release hardening, not architecture."

---

## Post-implementation audit (blueprint protocol final step) — 2026-07-01

- Session: `019f20a7-eaf1-7ac0-94ba-a122d4021595` · xhigh · fresh · audited the BUILT artifact on `chore/aztec-5.0.0-rc.2` + the code-review dispositions as first-class decisions.

### Verdict

`conditional approve (with conditions: fix the benchmark action's unscoped npx execution and restore prerelease dist-tag hygiene)`

### Findings → dispositions

1. **HIGH — dependency confusion in the GitHub Action** (`action/index.cjs:55` shelled `npx aztec-benchmark`; the unscoped registry name is not ours → RCE target on runners without a local install; upstream-inherited). FIXED: `exec.exec('npx', ['--yes', '@alejoamiras/aztec-benchmark', ...cliArgs])` + ncc rebundle.
2. **HIGH — latest-tag remediation contradicted the plan's "no latest until stable"** AND codex contradicted the code-review verifier on npm first-publish behavior (docs say `--tag` avoids `latest`; verifier claimed the registry always sets it). RESOLVED BEHAVIOR-AGNOSTICALLY: canary attempts `npm dist-tag rm latest` when latest lands on a canary; release retries removal and only re-points latest→rc as the logged least-bad fallback if the registry refuses removal. Auditor disagreement recorded — the code covers both realities.
3. Skipped code-review findings (FeeWrappedInteraction semantics) judged **defensible** for the compat rc. Idempotency guard's dist-tag re-add judged correct. No further consumer-breaking manifest issues found.
