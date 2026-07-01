# Phase 2 lessons — import aztec-benchmark

## Gate results (2026-07-01)

| Item | Result |
|---|---|
| `bun run --cwd packages/aztec-benchmark build` | ✓ tsc clean + ncc bundle `action/dist/index.cjs` (488kB) |
| CLI smoke (`start --help`) | ✓ usage printed |
| `bun run lint` | ✓ (16 `noExplicitAny` WARNINGS via the per-package override — debt item, by design) |
| `bun run lint:actions` | ✓ |
| `bun pm untrusted` | ✓ 0 untrusted lifecycle-script deps (no trustedDependencies needed yet; recheck in Phases 3/4) |

## What happened

1. Snapshot import (dev@0c68996) committed with `--no-verify` so hooks couldn't reformat the provenance commit; reformat/fix/curation landed as separate commits.
2. **Manifest curation (D15)**: name → `@alejoamiras/aztec-benchmark`; `repository` → this repo + `directory`; `@aztec/aztec.js` + `@aztec/wallets` → exact peerDependencies (verified: the only `@aztec/*` the shipped CLI imports) with devDeps mirrors for local dev; `@types/node` → devDeps; stripped `prepare: husky`, prettier/lint-staged/commitlint config, `packageManager`, `config.aztecVersion` (root owns it).
3. **First real migration bug — bun isolated-linker declaration emit (TS2742)**: tsc could not emit portable `.d.ts` for 3 inferred return types in `cli/feeWrappedInteraction.ts` referencing `@aztec/stdlib/tx` (an UNDECLARED transitive — exactly the class codex round-1 H8 predicted). Declaring `@aztec/stdlib` did NOT fix it (tsc realpaths through symlinks into the `.bun` store regardless). Fix: explicit `ReturnType<ContractFunctionInteraction['request'|'profile'|'send']>` annotations — portable via the already-imported type, no stdlib reference in the emitted declarations. stdlib kept in devDeps only.
4. **CI vendoring** (`_pr-benchmark.yml`, `_update-baseline.yml`, `.github/actions/setup-aztec/action.yml` — the setup action pulled forward from Phase 5 because actionlint validates local action paths):
   - Execution/comment job split (codex C3): benchmark job read-only; comment job (`pull-requests: write`) never runs PR code; fork PRs skip the comment job.
   - Baseline artifacts namespaced `benchmark-baseline-<pkg>-<branch>`; comment marker namespaced `<!-- benchmark-diff-<pkg> -->` appended to the report (upstream's generic marker would cross-minimize other packages' comments).
   - Non-vacuous assertions (D17): results JSON count ≥1; baseline-present ⇒ comparison pairs ≥1 (independent recount in the report step, not trusting comparison.cjs's happy markdown).
   - `--skip-proving` default TRUE on PR benches, FALSE on baselines (I1 mitigation; flag verified in cli.ts:28).
   - setup-aztec hardened per codex C2: version regex-validated, env-passed, `curl --fail --proto '=https' --tlsv1.2`; `~/.aztec` cached by version; foundry v1.4.1; runner default `ubuntu-latest` (not `-m`).
   - SHA pins: oven-sh/setup-bun@0c5077e5 (v2), foundry-rs/foundry-toolchain@c7450ba6 (v1), peter-evans/create-or-update-comment@71345be0 (v4), dawidd6/action-download-artifact@0bd50d53 (v12, upstream's pin kept).
5. shellcheck-in-actionlint gotcha: `# shellcheck disable=` directives must sit IMMEDIATELY above the offending command, not at script top (two rounds to land).

## Notes forward

- The vendored workflows are unexercised until Phase 5 wires per-package gates (`pr-workflow` input = gate filename). M2 adaptations all encoded now.
- dawidd6 `found_artifact` output deliberately NOT relied on — baseline presence detected by file count inside the report step (runtime-robust).
