# Harden Report: security

**Repo:** ecosystem-tooling / `packages/aztec-fee-payment` (`@alejoamiras/aztec-fee-payment@5.0.1`)
**Date:** 2026-07-16
**Effort:** medium
**Run ID:** 2026-07-16-shd501
**Models:** Phase 1 map — Sonnet (Explore); Phase 2 finders — Claude Sonnet ×4 clusters + Codex (gpt-5.6-sol, medium) ×4 clusters; Phase 3 coordinate + Phase 4 verify — main agent (Fable).
**Scope:** `packages/aztec-fee-payment` only — Noir contract (`src/nr`: PrivateFPC entrypoints, bridge/nullifier crypto, fpc_lib), TypeScript SDK (`src/ts`: fee-payment methods, gas utils, deploy/register, artifactRegistry), address/canonical-deployment machinery, npm packaging surface. **Excluded** (parked for a future whole-repo pass): the release pipeline, other packages, generated `src/artifacts` (as style, but production-wired instances audited), `dist`/`target` as code.

## Executive summary

The just-released Fee Payment Contract package was audited at medium effort with cross-model coverage (Claude + Codex) on four clusters. **The Noir contract core is clean under both models** — the entrypoint phase-safety, nullifier double-spend prevention, `msg_sender` authorization, u128 arithmetic (clusters C1) and the bridge-secret / FeeJuice-nullifier cryptographic derivation (C2) each drew **zero findings from both Claude and Codex independently**, with both models recomputing the domain separator (`0xEB935FC6` / `3952304070`) and tracing the nullifier derivation against the real Aztec 5.0.1 protocol path. For a fully-private, no-admin, no-upgrade contract that moves real funds, that convergent clean result on the crypto core is the most important outcome.

All four findings are on the **TypeScript SDK / packaging surface, and none are Critical or High.** The one that matters is **F-001 (Medium)**: `estimateGasSettings` trusts node-reported gas prices with no absolute ceiling, and because the FPC deducts the full `max_gas_cost` with no refund, a user connected to a malicious/compromised RPC node can have their internal FPC balance drained (per-user, up to their balance) — flagged by **both** models independently. The remaining three are Low: a self-referential canonical-address safety net (F-002), dead/dev-only `artifactRegistry.ts` code with weak validation (F-003), and a test-only Counter contract shipping in the tarball (F-004).

**Recommended priority:** none require an emergency `-revision.N` hotfix (nothing published is broken; the contract's no-refund model is intentional and correct). F-001 and F-002 are additive, backward-compatible SDK hardening — **defer to the next lockstep release**. F-003/F-004 are cleanup — bundle at next touch.

## Methodology

Map-reduce, coordinator-of-specialists. **Deviations from the formal medium spec (documented honestly):** (1) Phase 1 used one Sonnet Explore mapper for the single package (no monorepo hierarchical split needed — scope was one package). (2) Phase 2 ran 1 Claude + 1 Codex per cluster as specified, but the two Codex invocations each covered two clusters (C1+C2, C3+C4) rather than one Codex process per cluster — same 2-model-per-cluster coverage, fewer processes. (3) Medium effort has NO Phase 2.5 cross-rebuttal; not run. (4) Phase 3 coordinator + Phase 4 verifier were done inline by the main agent rather than a spawned Sonnet coordinator — justified by the small post-dedup finding set (4) and because the two highest-value results (Noir-core-clean, gas.ts-finding) were already cross-model-convergent, which is the verification signal. The main agent independently re-read gas.ts:183-234 and index.ts to confirm F-001's load-bearing claims before reporting. Inter-procedural context was capped per cluster; handoff edges (SDK gas estimate → declared GasSettings → on-chain `get_max_gas_cost` → `pay_fee` deduction) were traced across the TS/Noir boundary for F-001. Negative list applied (no dead-code findings rated as live-exploitable; dev-only vs production-reachable stated explicitly per finding).

## Findings

See `findings/verified.md` for the full per-finding detail (instances, traces, fixes). Summary table:

| ID | Impact | Confidence | Finding | Prod-reachable | Found by |
|---|---|---|---|---|---|
| F-001 | **Medium** | High | `estimateGasSettings` unbounded trust in node gas prices + FPC no-refund → RPC-node-driven balance drain | Yes (public API) | Claude + Codex |
| F-002 | Low | Moderate | Canonical-address guard self-referential; `registerPrivateContract` no canonical cross-check | Design gap | Claude (Codex: same facts, rated test-gap) |
| F-003 | Low | High | `artifactRegistry.ts` ships but is dead/dev-only: unvalidated fetch + unauth upload | No (dead/dev-only) | Claude + Codex |
| F-004 | Low | High | Test-only `CounterContract` binding + 1.2MB artifact + unexported `artifactRegistry` ship in tarball | Deep-import only | Claude + Codex |

**F-001 — `estimateGasSettings` unbounded node trust + no-refund FPC (Medium, HIGH confidence, both models).**
`estimateGasSettings` (root-exported public API, `src/ts/index.ts:42`) reads `getCurrentMinFees()` and `getNodeInfo().txsLimits.gas` from a caller-supplied node and turns them into the transaction's declared `GasSettings` with only a fixed 1.2× multiplier and no absolute ceiling (`gas.ts:189,192-195`; the `padAndClampGas` "clamp" is sourced from the same node, so not independent — verified at gas.ts:183-234). On-chain, `get_max_gas_cost` recomputes from those declared settings and `pay_fee` deducts the full amount **with no refund** (`fpc_lib/src/lib.nr:17-27`, `main.nr:46-58`). A user on a hostile/compromised/MITM'd RPC endpoint has inflated fees faithfully turned into an inflated permanent debit, up to their whole FPC balance (or a sponsored-tx denial above it). Per-user, not a cross-user or pool drain. **Fix:** add an optional caller-supplied absolute cost ceiling (`maxAcceptableGasCost`) checked client-side before the values become `GasSettings`. Additive, backward-compatible — defer to next release. Effort: hours.

**F-002 — Canonical-address safety net self-referential (Low, moderate).**
`canonical.test.ts` only checks JSON↔artifact↔README↔pin internal consistency (no external anchor), and `registerPrivateContract` accepts any salt with no canonical cross-check; the canonical JSON isn't even in the `exports` map. A coordinated bad edit or a stale integrator salt silently moves the fund-bridging address with nothing to flag it (no on-chain existence check for this constructor-less private contract). **Fix:** export the canonical record as a subpath; add an opt-in `assertCanonical` cross-check to `registerPrivateContract`. Defer. Effort: hours.

**F-003 — `artifactRegistry.ts` dead/dev-only with weak controls (Low, high — not reachable).**
The fetch-and-cast-to-`NoirCompiledContract` path (no schema/hash/signature validation) has **zero callers repo-wide** (both models grep-confirmed); the unauthenticated env-controlled upload path (no scheme allowlist, followed redirects) is only reached by the manual `scripts/upload-artifact.ts` dev CLI. Ships in `dist` but not in `exports` (deep-import only). Not exploitable today; forward-risk if wired in. **Fix:** delete if unused (preferred), or add validation + `https:`-allowlist + tarball exclusion. Defer.

**F-004 — Test contract + unexported code ship in the tarball (Low, high — hygiene).**
`npm pack --dry-run --json` confirmed the 5.0.1 tarball ships `target/counter_contract-Counter.json` (1.2MB, test-only contract) and a deployable `CounterContract` binding, plus `artifactRegistry.js`/`.d.ts`, none in the `exports` map. Attack-surface/trust-confusion + bloat, not a bypass. **Fix:** curate `files`/`.npmignore` to ship only the PrivateFPC artifact + exported SDK. Defer; bundle with F-003.

## Findings NOT pursued (with reasoning)
- **Noir phase safety / double-spend / authz / arithmetic (C1)** — both models traced clean: fee-payer election is bound to the non-revertible phase, the FPC-siloed replay nullifier is distinct from FeeJuice's, `msg_sender` is bound into the nullifier derivation (Bob can't claim Alice's deposit), u128 arithmetic fails proof-gen on overflow rather than wrapping.
- **Bridge crypto (C2)** — both models recomputed the domain separator and confirmed the FeeJuice message/nullifier derivation is byte-identical to the protocol; claimer + chain-id + version all bound.
- **SDK selectors / payload ordering / deploy params / secret logging (C3)** — Codex traced all fail-closed; no injection point, `universalDeploy`/`PublicKeys.default()` unconditional, no package-controlled secret-disclosure sink.
- **`get_bridge_gas_msg_hash` no static version-parity check** — fails closed (DoS not theft) + covered by mandatory E2E CI; structural observation only.

## Cross-cutting observations
1. **Zero active Noir unit coverage on the three fund-moving entrypoints.** `pay_fee`/`mint`/`mint_and_pay_fee` TXE tests are all commented-out BLOCKED (TXE can't seed a FeeJuice nullifier, runs zero gas, `end_setup()` breaks kernel sim). They're covered only by live-network integration (`private.test.ts`), and `mint_and_pay_fee` only by the assertion-less benchmark. Not a vulnerability, but the fastest, most isolated test tier for the most security-critical logic is disabled. A mock-oracle/fixture harness giving these unit coverage would materially strengthen regression safety. (Aligns with the roadmap's existing "structural test debt" item.)
2. **The contract math is solid; the real exposure is client-side node trust.** F-001 is the theme — the SDK should treat the RPC node as untrusted and hand integrators the caps to enforce it. Every finding of substance lives in the TS trust boundary, not the ZK circuit.
