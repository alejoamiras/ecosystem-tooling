# Phase 7 lessons — docs, wrap-up & final report

## Gate results (2026-07-02)

| Item | Result |
|---|---|
| `bun run lint` | ✓ exit 0 (fresh, post-docs) |
| `bun run lint:actions` | ✓ exit 0 |
| Full test evidence at the released sha | ✓ local `bun run test:nr` 340/340 + vitest 40/40 (fee-payment on fresh network); release workflow re-validated the ENTIRE suite matrix in-workflow **twice** (runs 28596810501, 28598638218) — six green revalidation jobs each |
| Docs match shipped state | ✓ README (attribution + migration mapping), docs/ci-pipeline.md (workflow map, runbook, empirical registry findings), docs/roadmap.md, CLAUDE.md, implementations-plan/index.md |

## WRAP-UP REPORT (blueprint mid, protocol complete)

**Delivered**: `ecosystem-tooling` bun monorepo (github.com/alejoamiras/ecosystem-tooling) consolidating defi-wonderland's three Aztec packages, released as **`@alejoamiras/{aztec-benchmark,aztec-standards,aztec-fee-payment}@5.0.0-rc.2`** on npm — `rc` dist-tag, provenance attestations, tag `v5.0.0-rc.2`, GitHub release — via a tokenless OIDC pipeline that re-validates everything before publishing. Canary bootstrap (`0.0.0-canary.gb8d1485` ×3) proved the pipeline and created the names.

**Verification totals**: TXE 340/340 (329 standards + 11 fee-payment); vitest 40/40 (29+11, incl. L1 FeeJuice bridging and the relocated-sandbox isolation proof 3/3); benches non-vacuous ×2 packages; verify-tarball 15/15 against the REAL legacy 4.2.0 nested layout; PR #1 matrix 14/14 on two heads; main cascade green; baselines seeded; clean-room npm install+import smoke of the PUBLISHED rc.2.

**Contentious decisions & how they resolved** (ELI5 context per the return protocol):
1. *Ship from the target pipeline vs release-first* (D1) — chose migrate-then-release; final codex agreed after the strawman was struck; upstream fee-payment#166's cross-repo version skew became the pro-monorepo exhibit.
2. *`workspace:*` vs exact pins* (D14) — audits caught that npm CLI publishes the protocol string verbatim; exact lockstep pins won, maintained by `bump-aztec.ts`.
3. *`@aztec/*` peers vs zero-dep tarballs* (A6/D18) — user chose exact peerDependencies: loud version conflicts beat silent duplicate-aztec.js class-identity bugs.
4. *"Benchmarks as gates" semantics* (A7/D17) — comparison tooling is report-only (verified: no exit-code path); gates assert non-vacuous results; numeric blocking is roadmap.
5. *FeeWrappedInteraction upstream bugs* (code-review) — precedence inversion + dropped gasSettings CONFIRMED but deliberately NOT fixed in a compat rc (would change benchmark semantics vs all existing baselines); queued as follow-up patch.
6. *npm first-publish `latest` behavior* — our two audit models CONTRADICTED each other; resolved with behavior-agnostic code; the field report won (first publish DID set latest), and E400-on-delete settled the endgame: latest is only movable → policy: latest tracks the newest real release.
7. *Dependency confusion in the shipped GitHub Action* (codex post-impl HIGH) — inherited `npx aztec-benchmark` (unscoped, unowned name) → scoped invocation + ncc rebundle before release.

**Codex consults (AFK protocol log)**: plan round-1 (conditional approve — all adopted), final fresh-context pass (conditional approve — all adopted, one partial rejection D19 recorded), post-impl audit (conditional approve — 2 HIGHs fixed). Zero conflicts with hard limits.

**Open items (roadmap / user)**:
- USER: point `latest` → rc.2 (`npm dist-tag add @alejoamiras/<pkg>@5.0.0-rc.2 latest --otp=…` ×3 — E401/E400 journey documented); confirm BOTH bootstrap tokens revoked (both touched the transcript); A8 — ask Wonderland to `npm deprecate` the old packages while they still can.
- Two unsigned docs commits on main (c3c5ebd, b8d1485) — user declined-by-default to rewrite; recorded.
- Roadmap: FeeWrappedInteraction fix patch, vitest-4 poolOptions cleanup, full run-isolation registry, aztec-nightlies automation, numeric bench blocking, stable 5.0.0 (revisit lockstep/min-age/foundry pin/dist-mirror), org transfer runbook, /harden security (deferred by A5).
