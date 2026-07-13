# Roadmap

## Recently completed

- `aztec-5-stable` (2026-07) — **v5.0.0 (stable) migration + release**: code migrated (incl. the unlisted upstream mspk/fbpk derivation change), legacy `dist/` mirror removed from aztec-standards (as promised at consolidation), release pipeline redesigned after a 3-round audit (mode-based release.yml with rehearsal/hotfix overlays, fail-closed tarball assertions, OIDC job split, SHA binding + payload comparison, attestation-identity verification, Nargo ref-locking, full-surface typecheck + TXE count-floor gates), canonical PrivateFPC deployment parameters committed and machine-asserted, bootstrap-era `canary.yml` retired. Stable-revisit decisions: lockstep KEPT (hotfixes = `<version>-revision.N` via the hotfix mode), `@aztec/*` min-age exemption KEPT (mechanical report compensates), foundry v1.4.1 KEPT (upstream parity).
- `wonderland-consolidation` (2026-07-02) — three Wonderland packages consolidated; v5.0.0-rc.2 released to npm with provenance via the tokenless OIDC pipeline.

## Deferred

- **Canonical 5.0.0 deployments**: `deployments.json` still ships Wonderland-era historical addresses (labeled as such in the README) — regenerate once canonical 5.0.0 network deployments exist (`deploy.ts --write-deployments`).
- **Full run-isolation**: `~/.agents` port registry + `scripts/run/agent.sh` + per-run sandbox `HOME` (only the `NODE_URL`/`L1_RPC_URL` env seam ships today).
- **Upstream tracking automation**: `aztec-nightlies.yml` / `aztec-stable.yml` style workflows that open bump PRs via `scripts/bump-aztec.ts` when new Aztec versions publish.
- **Benchmark numeric regression-blocking**: `--fail-on-regression` mode + calibrated thresholds (gates are non-vacuous report-mode until then).
- **aztec-network org transfer runbook**: scope rename, trusted-publisher re-config, README redirects.
- **`/harden security` whole-repo pass**: scheduled for the org transfer (decision reaffirmed at 5.0.0 approval). Parked for it explicitly: escrow `key_derivation.nr` + unaudited sha512 dependency audit, Nargo manifest SHA-pinning question (ref-lock enforcement ships now; in-manifest pins deferred), npm-binary deep integrity pinning, deep Sigstore chain verification beyond the current audit-signatures + predicate-identity layers.
- **Wonderland deprecation notice**: ask Wonderland to `npm deprecate` the old `@defi-wonderland/*` packages pointing here — user action, deferred to the aztec-network move (user decision 2026-07-13).
