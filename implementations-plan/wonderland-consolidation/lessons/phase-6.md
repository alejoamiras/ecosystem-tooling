# Phase 6 lessons — Aztec 5.0.0-rc.2 bump (LOCAL HALF COMPLETE; release pending remote unlock)

## Local validation at rc.2 (all green, 2026-07-01 evening)

| Layer | standards | fee-payment | benchmark |
|---|---|---|---|
| compile + codegen (rc.2 toolchain) | ✓ 8 contracts | ✓ 3 packages | n/a |
| TXE (sandbox down) | ✓ **329/329** | ✓ **11/11** | n/a |
| vitest vs rc.2 network | ✓ **29/29** (+7 skip) | ✓ 8 unit; **3/3 integration on FRESH network** | n/a |
| bench `--skip-proving` `_rc2` suffix | ✓ 5/5 files | ✓ 1/1 | n/a |
| build | ✓ | ✓ | ✓ |
| lint | ✓ repo-wide | | |

## bump-aztec.ts maiden run — script fixes discovered by usage

1. **npm-alias blindness**: `@aztec/viem` hides behind the `viem` alias (`npm:@aztec/viem@x`) — closure now parses alias specs (would have blocked install on a <7d @aztec/viem).
2. **Wrong closure seeds**: BFS from SDK roots missed `@aztec/noir-contracts.js` (a direct dep that's nobody's transitive) — install blocked until the closure seeded from OUR manifests' declared @aztec names. Final closure: **31 packages**.
3. Registry-verified target guard + supply-chain report worked as designed. Report finding worth repeating: **upstream @aztec rc.2 has NO provenance attestations** on any of the 29 closure packages.

## rc.2 API migration (exactly as trust-tiered)

- Noir: `ContractInstance.contract_class_id` → `original_contract_class_id` — applied via `git apply --directory=packages/aztec-standards --include='*.nr'` of upstream #358's diff (their CI green; 4 files).
- TS: `fromBigInt`→`fromBigIntUnsafe` (1 site), `fromString`→`fromStringUnsafe` (3 sites in fee-payment benchmarks — **the fix upstream #166 lacks**; rc.2 d.ts confirms ALL address constructors gained Unsafe suffixes).
- #166 and #95 diffs verified pure version bumps — nothing else to mirror. Lockstep monorepo advantage confirmed: our benchmark CLI bumped in the same commit, no cross-repo skew possible.

## Environmental sagas

- **aztec-up install silently aborts when anvil is running** (foundryup refuses; script exits 0 anyway, leaving a half-installed version dir — bin/ empty). Detection: check `bin/` non-empty after install. Fix: stop sandbox first, reinstall.
- `aztec-up install` flips `~/.aztec/current` to the new version (global machine state — acceptable; rc.1 stays installed).
- **Fee-payment integration is aged-sandbox-sensitive**: `Timeout awaiting isMined` in the FeeJuice-bridge beforeAll against a sandbox that had served hours of suites (L1 time warps suspected); fresh sandbox → 3/3. Runbook note added (CI always uses fresh networks; locally restart before this suite).
- zsh errexit quirk: a failing `A && B | tail` line inside `{ }` did NOT stop the mega-chain — per-step exit capture is mandatory, don't trust `set -e` through pipelines.
- Every Bash call now prefixes an absolute `cd` — the persistent-cwd footgun bit four times this session.

## Blocked remainder (needs user)

1. 1Password unlock → push main + `chore/aztec-5.0.0-rc.2` → PR (body ready: `release-pr-body.md`) → gates green (Phase 5 gate part 1).
2. `npm login` + A2 scope token in env `npm-publish` → dispatch `canary.yml` → configure trusted publishers ×3 → revoke token (Phase 5 gate part 2).
3. Merge bump PR → dispatch `release.yml 5.0.0-rc.2` → post-release assertions (Phase 6 gate).
