# Roadmap

## Recently completed

- `wonderland-consolidation` (2026-07-02) — three Wonderland packages consolidated; **v5.0.0-rc.2 released to npm** with provenance via the tokenless OIDC pipeline. Full trail: `implementations-plan/wonderland-consolidation/`.

## Deferred (deliberately out of the consolidation plan)

- **Full run-isolation**: `~/.agents` port registry + `scripts/run/agent.sh` + per-run sandbox `HOME` (only the `NODE_URL`/`L1_RPC_URL` env seam ships in the consolidation).
- **Upstream tracking automation**: `aztec-nightlies.yml` / `aztec-stable.yml` style workflows that open bump PRs via `scripts/bump-aztec.ts` when new Aztec versions publish.
- **Benchmark numeric regression-blocking**: `--fail-on-regression` mode + calibrated thresholds for the comparison step (gates are non-vacuous report-mode until then — approval decision A7).
- **aztec-network org transfer runbook**: scope rename, trusted-publisher re-config, README redirects.
- **Stable `5.0.0` release**: revisit lockstep-vs-independent versioning, the `@aztec/*` min-age exclusion, the foundry v1.4.1 pin, and removal of the legacy `dist/` mirror in the standards package.
- **`/harden security` whole-repo pass**: decision deferred (approval A5) — revisit at stable release or org transfer.
- **Wonderland deprecation notice**: ask Wonderland to `npm deprecate` the old `@defi-wonderland/*` packages pointing here once rc.2 ships (user action, time-boxed by their contract end).
