# chore: bump Aztec to 5.0.0-rc.2 (lockstep)

One-command sweep via `bun scripts/bump-aztec.ts 5.0.0-rc.2` (+ `--regenerate-excludes` post-install): root `config.aztecVersion`, 42 manifest pins (deps/devDeps/peerDeps + internal `@alejoamiras/*`), 10 `Nargo.toml` aztec-packages tags, fee-payment PRD header, and the 31-package `@aztec/*` min-age exclusion closure in `bunfig.toml` (rc.2 is ~2 days old — inside the 7-day quarantine; exact pins + frozen lockfile bound the residual risk, plan §4/D9).

## rc.2 API migration (trust-tiered per plan Phase 6)

- **Noir** (mirrors upstream defi-wonderland/aztec-standards#358, whose CI is green): `ContractInstance.contract_class_id` → `original_contract_class_id` (4 files: escrow logic/tests, vault_deployer).
- **TS**: address constructors gained `Unsafe` suffixes — `fromBigIntUnsafe` (standards test utils, same as #358), `fromStringUnsafe` ×3 (fee-payment `benchmarks/private.benchmark.ts` — **the fix upstream #166 is missing**; their benchmark CI job is red on exactly this).
- upstream aztec-benchmark#95 and fee-payment#166 diffs verified pure-version-bump — nothing else to mirror.

## Validation (local, Apple Silicon + rc.2 toolchain)

| Layer | standards | fee-payment | benchmark |
|---|---|---|---|
| compile + codegen (rc.2 nargo) | ✓ 8 contracts | ✓ 3 packages | n/a |
| TXE | ✓ 329/329 | ✓ 11/11 | n/a |
| vitest vs rc.2 local network | ✓ 29/29 (+7 skip) | ✓ 8 unit + 3/3 integration (fresh network — see note) | n/a |
| bench (`--skip-proving`, non-empty) | ✓ 5/5 files | ✓ 1/1 | n/a |
| build | ✓ | ✓ | ✓ tsc+ncc |

**Note (fee-payment integration)**: first rc.2 run hit `Timeout awaiting isMined` in the FeeJuice-bridge `beforeAll` against a LONG-LIVED sandbox; re-run against a fresh rc.2 network: **3/3 passed**. Root cause: aged-sandbox state sensitivity (L1 time warps from earlier suites), not rc.2 — runbook note added (fee-payment integration wants a fresh network, which is what CI provides anyway).

## Supply-chain report (from bump-aztec.ts, 2026-07-01)

All 29 `@aztec/*` closure packages published 2026-06-29T18:05–18:10Z (age ~2.2 days at bump time). **None carry provenance attestations upstream** — noted; the packages published FROM this repo do (trusted publishing + `--provenance`).

## Release checklist (after merge — plan Phase 5/6 gates)

- [ ] Canary published via bootstrap token (creates the three names) — **blocked on A2 user steps**
- [ ] Trusted publishers configured ×3 (repo `alejoamiras/ecosystem-tooling`, workflow `release.yml`, environment `npm-publish`, allowed action `npm publish`); token revoked
- [ ] `release.yml` dispatched with `5.0.0-rc.2` (re-validates in-workflow, packs + verify-tarball, publishes benchmark→standards→fee-payment with provenance, tags `v5.0.0-rc.2`)
