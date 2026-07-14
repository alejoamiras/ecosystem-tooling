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
- **`/harden security` whole-repo pass**: scheduled for the org transfer (decision reaffirmed at 5.0.0 approval). Parked for it explicitly, from the post-impl codex audit:
  - escrow `key_derivation.nr` + unaudited sha512 dependency audit;
  - **Aztec toolchain supply chain**: `setup-aztec` restores `~/.aztec` from an OS+version-keyed cache and, on miss, runs the `aztec-up` installer with no committed checksum — a persistently-poisoned cache/installer would produce matching rehearsal+release tarballs (payload compare can't catch it). Pin+verify the installer/toolchain digest, or disable the toolchain cache in release builds;
  - **Nargo compile-from-locked-commit**: the release build re-runs `verify-nargo-refs.sh` before compile, which NARROWS but does not close the TOCTOU (aztec compile re-resolves tags independently). True fix: rewrite manifests to the locked commit SHA before compiling, or vendor the deps;
  - Nargo manifest SHA-pinning question (ref-lock enforcement ships now; in-manifest pins deferred);
  - npm-binary deep integrity pinning beyond the exact-version assertion.
- **Structural test debt** (recurring lesson across every phase): the security/release gates are ad-hoc shell + node one-liners first exercised in live choreography (pipefail death, npm `./`-path parsing, TOML-quote escapes, verified-bundle handling all surfaced that way). Add hermetic fixture tests — sample Nargo.toml forms, a captured attestation bundle, mocked `npm view` output — so these gates have adversarial unit coverage instead of comments + operator memory.
- **canonical-deployment.json absent from the shipped 5.0.0 tarball**: added to fee-payment's `files` after the release, so it lands with the next version; until then the machine-checked README is the consumer surface. Immutable — no revision-only release warranted.
- **Wonderland deprecation notice**: ask Wonderland to `npm deprecate` the old `@defi-wonderland/*` packages pointing here — user action, deferred to the aztec-network move (user decision 2026-07-13).
