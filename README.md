# ecosystem-tooling

Aztec ecosystem packages — a bun monorepo consolidating the smart-contract standards, fee-payment contracts, and benchmarking tooling originally built by [Wonderland](https://github.com/defi-wonderland) as an Aztec core contributor.

> **Status: work in progress.** Packages are being migrated in; the first release target is Aztec `v5.0.0-rc.2`.

## Packages

| Package | Description | Continues |
|---|---|---|
| `@alejoamiras/aztec-benchmark` | Benchmark CLI + GitHub Action for Aztec contracts | [defi-wonderland/aztec-benchmark](https://github.com/defi-wonderland/aztec-benchmark) @ `0c68996` |
| `@alejoamiras/aztec-standards` | Reusable standardized Aztec contracts (token, vault, NFT, escrow, …) | [defi-wonderland/aztec-standards](https://github.com/defi-wonderland/aztec-standards) @ `1cade05` |
| `@alejoamiras/aztec-fee-payment` | Private Fee Payment Contract (FPC) + TypeScript SDK | [defi-wonderland/aztec-fee-payment](https://github.com/defi-wonderland/aztec-fee-payment) @ `def90aa` |

Package versions track the Aztec version they target (e.g. `5.0.0-rc.2` works with Aztec `5.0.0-rc.2`).

## Attribution

These packages continue the MIT-licensed work of Wonderland (defi-wonderland) after the end of their core-contributor engagement. Original copyright notices are preserved in each package's `LICENSE` and in the root [LICENSE](LICENSE). Source histories remain browsable in the upstream repositories; this repo starts from snapshots of the commits listed above.

## Development

```bash
bun install          # workspace install (7-day min-age supply-chain gate, see bunfig.toml)
bun run lint         # biome + sort-package-json
bun run lint:actions # actionlint on workflows
bun run test:nr      # Noir TXE tests (needs the aztec CLI)
bun run test:js      # TS integration tests (needs `aztec start --local-network`)
```

The Aztec toolchain version is pinned in the root `package.json` `config.aztecVersion` — the single source of truth consumed by CI and the bump tooling.

## License

MIT — see [LICENSE](LICENSE).
