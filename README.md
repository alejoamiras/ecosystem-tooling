# ecosystem-tooling

Aztec ecosystem packages — a bun monorepo continuing the fee-payment contracts and benchmarking tooling originally built by [Wonderland](https://github.com/defi-wonderland) as an Aztec core contributor.

> **aztec-standards has moved**: the Aztec Foundation now owns and publishes it as [`@aztec-foundation/aztec-standards`](https://www.npmjs.com/package/@aztec-foundation/aztec-standards) ([AztecProtocol/aztec-standards](https://github.com/AztecProtocol/aztec-standards)). The `@alejoamiras/aztec-standards` package is deprecated.

**Current release: `5.0.1`** (lockstep with the Aztec version it targets) — published to npm with [provenance attestations](https://docs.npmjs.com/generating-provenance-statements) via a tokenless OIDC pipeline.

## Packages

| Package | npm | Description |
|---|---|---|
| [`@alejoamiras/aztec-fee-payment`](https://www.npmjs.com/package/@alejoamiras/aztec-fee-payment) | [![npm](https://img.shields.io/npm/v/@alejoamiras/aztec-fee-payment.svg)](https://www.npmjs.com/package/@alejoamiras/aztec-fee-payment) | Private Fee Payment Contract (FPC) + TypeScript SDK |
| [`@alejoamiras/aztec-benchmark`](https://www.npmjs.com/package/@alejoamiras/aztec-benchmark) | [![npm](https://img.shields.io/npm/v/@alejoamiras/aztec-benchmark.svg)](https://www.npmjs.com/package/@alejoamiras/aztec-benchmark) | Benchmark CLI + CI machinery for Aztec contracts (gates, DA/L2 gas, proving) |

Package versions track the Aztec version they support: install `@alejoamiras/aztec-fee-payment@5.0.1` for Aztec `5.0.1` (`latest`). Pre-releases live under the `rc` dist-tag; emergency fixes to a lockstep version ship as `<version>-revision.N` under `revision`.

## Migrating from `@defi-wonderland/*`

These packages continue Wonderland's work after the end of their core-contributor engagement — same code lineage, same import paths, new scope and home:

| Before | After |
|---|---|
| `@defi-wonderland/aztec-standards` / `@alejoamiras/aztec-standards` | [`@aztec-foundation/aztec-standards`](https://www.npmjs.com/package/@aztec-foundation/aztec-standards) (Aztec Foundation, 5.0.1+) |
| `@defi-wonderland/aztec-benchmark` (last publish: 5.0.0-rc.1) | `@alejoamiras/aztec-benchmark` (5.0.0+) |
| `@wonderland/aztec-fee-payment` (GitHub tarballs only) | `@alejoamiras/aztec-fee-payment` (first npm releases) |
| `uses: defi-wonderland/aztec-benchmark/.github/workflows/…` | see [benchmark CI integration](packages/aztec-benchmark/README.md#ci-integration) |

For fee-payment and benchmark: swap the scope in `package.json` — import paths are unchanged from the legacy layout. For aztec-standards: migrate to the Foundation package (its layout is owned by [AztecProtocol/aztec-standards](https://github.com/AztecProtocol/aztec-standards) — check its README for import paths).

## Development

```bash
bun install          # workspace install (7-day min-age supply-chain gate, see bunfig.toml)
bun run lint         # biome + sort-package-json
bun run lint:actions # actionlint on workflows
bun run test:nr      # Noir TXE tests (needs the aztec CLI)
bun run test:js      # TS integration tests (needs `aztec start --local-network`; NODE_URL/L1_RPC_URL to relocate)
bun run bench        # benchmark suites against the local network
```

The Aztec toolchain version is pinned in the root `package.json` `config.aztecVersion` — the single source of truth consumed by CI. Version bumps sweep the entire repo with one command: `bun scripts/bump-aztec.ts <version>` (see [docs/ci-pipeline.md](docs/ci-pipeline.md) for the full release runbook).

Heads-up for local runs: don't run `aztec test` while a local network is up on the same machine (documented LMDB interference — details in `docs/ci-pipeline.md`).

## Repository docs

- [docs/ci-pipeline.md](docs/ci-pipeline.md) — workflow map, release runbook, hard-won npm registry findings
- [docs/roadmap.md](docs/roadmap.md) — deferred work and future plans

## Attribution & license

MIT — see [LICENSE](LICENSE). Original code © 2024–2025 Wonderland ([defi-wonderland](https://github.com/defi-wonderland)), continued here from snapshots of `aztec-standards@1cade05`, `aztec-fee-payment@def90aa`, `aztec-benchmark@0c68996` (2026-07-01). Upstream histories remain browsable in the original repositories. The aztec-standards continuation lived here through `5.0.0` and was handed over to the Aztec Foundation in July 2026.
