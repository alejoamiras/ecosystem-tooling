# Verified findings — /harden security medium — packages/aztec-fee-payment@5.0.1

Run: 2026-07-16-shd501. Coordinator + verifier: main agent (Fable), reconciling 6 raw finder outputs (Claude Sonnet ×4 clusters + Codex medium ×4 clusters). Deduped by root-cause + sink + boundary; each finding lists all instances.

**Headline**: the Noir contract core (entrypoints, phase safety, nullifier/double-spend, bridge crypto derivation) is CLEAN under BOTH models — Claude and Codex each independently recomputed the domain separator (`0xEB935FC6`/`3952304070`) and traced the FeeJuice nullifier derivation against the real protocol path; 0 findings on clusters C1+C2. All 4 findings are on the TypeScript SDK / packaging surface, none Critical/High.

---

## F-001 — `estimateGasSettings` places unbounded trust in node-reported gas parameters; with the FPC's no-refund model this is real fund-loss exposure to a malicious/compromised RPC node
**Impact:** Medium (CVSS ~5.3 band — integrity, per-user, requires attacker-controlled RPC endpoint). **Confidence: HIGH.** **Mapping:** CWE-20 / CWE-345, OWASP A08:2021. **Found by: BOTH (Claude C4 + Codex C4 — cross-model convergence, the strongest signal).**

**Instances:**
- `packages/aztec-fee-payment/src/ts/utils/gas.ts:189` (`maxFeesPerGasFromBaseFees(await aztecNode.getCurrentMinFees(), …)` — no absolute ceiling)
- `packages/aztec-fee-payment/src/ts/utils/gas.ts:192-195` (`getNodeInfo().txsLimits.gas` used as both the value AND its own clamp)
- `packages/aztec-fee-payment/src/ts/utils/gas.ts:163-234` (whole function), `:146-151` (`maxGasCostFor`)
- `packages/aztec-fee-payment/src/ts/index.ts:42,44` (both are root-exported public API)
- `packages/aztec-fee-payment/src/nr/fpc_lib/src/lib.nr:17-27` (`get_max_gas_cost` recomputes from declared settings)
- `packages/aztec-fee-payment/src/nr/private_contract/src/main.nr:46-58` (`pay_fee` — "Does not refund unused gas")

**Verified trace:** `estimateGasSettings` (public root export) accepts a caller-supplied `aztecNode`, reads `getCurrentMinFees()` and `getNodeInfo().txsLimits.gas`, applies only a fixed 1.2× multiplier and validates `estimatedGasPadding` (finite, ≥0) — there is **no absolute upper bound** on the node-supplied base values (independently confirmed at gas.ts:183-234). The "clamp" (`padAndClampGas` against `maxGasLimits`) is sourced from the *same* node, so it is not an independent ceiling. The returned `GasSettings` become the transaction's declared settings; on-chain `get_max_gas_cost` recomputes `max_gas_cost` from those declared settings, and `pay_fee`/`mint_and_pay_fee` deduct the full amount from the user's private FPC balance **with no refund** (explicit in the contract). So an inflated node estimate is not a rarely-charged ceiling — it is the amount permanently burned.

**Why it matters:** a user on a malicious/compromised/MITM'd Aztec RPC endpoint has `estimateGasSettings` faithfully turn inflated `getCurrentMinFees()` into an inflated `maxFeesPerGas`; each sponsored tx then burns the inflated `max_gas_cost` from their internal FPC credit with no refund, up to their whole balance (or a reliable sponsored-tx denial above it). Blast radius is per-signing-user but scales with how many users share the hostile endpoint. Not a cross-user drain and not a drain of the FPC public pool.

**Recommended fix (smallest safe change):** add an optional caller-supplied absolute ceiling to `estimateGasSettings` — e.g. a `maxAcceptableGasCost` (or `maxFeesPerGas` cap) parameter checked client-side before the values become `GasSettings`, throwing if the node-derived cost exceeds it. Independent of anything the node reports. Document that integrators should set it. This is an SDK API addition, not a contract change.

**Disposition:** the released *contract* is not vulnerable (the no-refund model is intentional and correct); this is a client-SDK hardening gap. **Recommend DEFER to the next lockstep release** (5.0.2 or the next Aztec bump) as an additive, backward-compatible API parameter — NOT a `-revision.N` hotfix, since nothing published is broken and the mitigation is a new opt-in surface. Effort: hours.

---

## F-002 — Canonical-address fund-loss guard is self-referential; `registerPrivateContract` accepts any salt with no cross-check against `canonical-deployment.json`
**Impact:** Low (integrity / fund-loss-adjacent design gap; requires insider/pipeline compromise OR integrator error, not a remote attacker). **Confidence: moderate.** **Mapping:** CWE-345 (Insufficient Verification of Data Authenticity), OWASP A08:2021. **Found by: Claude C3 (as finding) + Codex C3 (same facts, rated as test-gap/documented-behavior — partial cross-model agreement on substance).**

**Instances:**
- `packages/aztec-fee-payment/src/ts/test/canonical.test.ts:22-47` (checks JSON↔artifact↔README↔pin self-consistency only — no external ground-truth anchor; does not execute `registerPrivateContract`)
- `packages/aztec-fee-payment/src/ts/utils/deploy.ts:23-28` (`registerPrivateContract` takes any `salt`, no cross-check vs canonical)
- `packages/aztec-fee-payment/package.json:13-31` (`canonical-deployment.json` not exposed as an importable `exports` subpath)

**Verified trace:** `canonical.test.ts` asserts three internal-consistency properties (version==pin, address==derivation-from-artifact+salt, README line embeds address) — but all three inputs live in the same repo, so a single coordinated edit across JSON+README passes CI green while silently moving the address every user is told to bridge funds to (no external anchor). Separately, `registerPrivateContract` — the runtime call dApps actually make — accepts an arbitrary `salt` with zero comparison to the canonical value, and the canonical JSON isn't even importable via the package `exports` map (integrators hand-copy it from README prose). The JSON's own comment confirms rc-era operator-local salts existed in the wild. For a fully-private, constructor-less contract there is no on-chain existence check to flag a wrong address before funds are lost. Codex independently confirmed the same test-coverage gap and the "noncanonical salt yields a valid but different address" behavior, rating it a gap rather than a finding.

**Why it matters:** the safety net that prevents the catastrophic "funds bridged to a stale/wrong address are unrecoverable" outcome is prose + self-referential CI, not a runtime guard. A coordinated bad edit or an integrator sourcing a stale salt bypasses it silently.

**Recommended fix:** (a) export `canonical-deployment.json` as a supported subpath so integrators import the value instead of copying prose; (b) add an optional `assertCanonical` path to `registerPrivateContract` that compares the derived address against the shipped canonical record and throws on mismatch; (c) optionally, have `canonical.test.ts` also assert against a value pinned outside the repo (e.g. the published npm tarball's prior record) to break the self-reference. Effort: hours. **Disposition: DEFER to next release** (additive SDK hardening).

---

## F-003 — `artifactRegistry.ts` ships in the tarball but is dead/dev-only code: unvalidated network-artifact fetch (no schema/hash/signature check) + unauthenticated env-controlled upload with followed redirects
**Impact:** Low today (forward-risk). **Confidence: HIGH** (grep-verified unreachable). **Mapping:** CWE-494, CWE-345, CWE-918, CWE-306; OWASP A08:2021 / A05:2021. **Found by: Claude C4 (2 findings) + Codex C4 (confirmed non-production-wired).**

**Instances:**
- `packages/aztec-fee-payment/src/ts/artifactRegistry.ts:107-125` (`fetchArtifactFromRegistry` — `res.text()` → `safeJsonParse` → returned as `unknown`)
- `packages/aztec-fee-payment/src/ts/artifactRegistry.ts:131-169` (`loadArtifactWithRegistryFallback` — `return artifact as NoirCompiledContract` bare cast, registry-first over local)
- `packages/aztec-fee-payment/src/ts/artifactRegistry.ts:27-53` (`getArtifactRegistryBaseUrl` — env `AZTEC_ARTIFACT_REGISTRY_URL` verbatim, no scheme allowlist; upload POST with no auth, default redirect follow)
- caller: `packages/aztec-fee-payment/scripts/upload-artifact.ts` (dev CLI only — the ONLY caller; download path has zero callers repo-wide)

**Verified trace:** BOTH models grep-confirmed `fetchArtifactFromRegistry`/`loadArtifactWithRegistryFallback` have **zero callers anywhere in the monorepo** — the download-and-cast path is dead code. The upload path's only caller is the manual `scripts/upload-artifact.ts` (confirmed NOT wired into any workflow — the `.github/workflows` `upload-artifact` hits are the unrelated built-in `actions/upload-artifact`). `AZTEC_ARTIFACT_REGISTRY_STRICT` governs upload error-swallowing only, not fetch validation. The module ships in `dist` (tsconfig.build includes it) but is not in the `exports` map, so it's reachable only by non-standard deep import (Node blocks the normal path with `ERR_PACKAGE_PATH_NOT_EXPORTED`).

**Why it matters:** not exploitable today (no production caller), but a poisoned-registry artifact becoming contract bytecode/ABI would be total integrity loss if a future refactor wires this in without noticing the missing validation. Shipping the `.d.ts` also makes it IDE-auto-importable/CDN-discoverable.

**Recommended fix:** delete `artifactRegistry.ts` if genuinely unused (preferred — it removes the forward-risk entirely), OR add `zod` schema + `classId`-hash validation to the fetch path, an `https:`-only scheme allowlist + `redirect: 'manual'` to the URL handling, and exclude it from the published tarball via `.npmignore`/curated `files`. Effort: hours. **Disposition: DEFER** (dead code; clean up at next touch).

---

## F-004 — Packaging ships test-only `CounterContract` binding + its 1.2MB raw artifact + unexported `artifactRegistry.js` to every consumer
**Impact:** Low (attack-surface/hygiene + ~1.2MB bloat). **Confidence: HIGH** (`npm pack --dry-run --json` confirmed by Codex). **Mapping:** CWE-749, OWASP A05:2021. **Found by: Claude C4 + Codex C4 (informational).**

**Instances:**
- `packages/aztec-fee-payment/package.json:34-39` (`files` whitelists all of `target` + `dist` wholesale; excludes only `*.json.bak`)
- `target/counter_contract-Counter.json` (1,209,208 bytes — test-only contract, ships; verified via `npm pack --dry-run`)
- `packages/aztec-fee-payment/src/artifacts/Counter.ts` (fully deployable `CounterContract.deploy()`/`.at()` binding, ships in dist, not in `exports`)
- `dist/src/ts/artifactRegistry.js` + `.d.ts` (ships, not in `exports`)

**Verified trace:** Codex ran `npm pack --dry-run --json`: the 5.0.1 tarball contains `target/counter_contract-Counter.json` (1.2MB, a test/benchmark-only contract) and `target/private_contract-PrivateFPC.json` (2.4MB); ~3.6MB unpacked before `dist`. Counter is a "Test utility contract for benchmarks and integration tests" (per package CLAUDE.md), not in the exports map, shipped with no doc caveat — an SCA tool or integrator could mistake it for a supported/audited contract under the FPC's trust umbrella.

**Why it matters:** widens the published trust surface and bloats installs; the deployable Counter binding + the auto-importable `artifactRegistry.d.ts` (F-003) could be built on under the false assumption they're supported SDK surface.

**Recommended fix:** curate the `files` field / add `.npmignore` to exclude `target/counter_contract-Counter.json`, `dist/src/artifacts/Counter.*`, and `dist/src/ts/artifactRegistry.*` from the tarball (ship only the PrivateFPC artifact + the exported SDK surface). Effort: minutes–hours. **Disposition: DEFER** (hygiene; bundle with F-003 cleanup).

---

## Findings NOT pursued
- Noir phase safety, double-spend/nullifier, msg_sender authz, u128 arithmetic, bridge-secret domain separator, FeeJuice nullifier derivation, claimer binding, comptime keccak selector — all traced clean by both models (C1+C2 = 0/0). Selector strings, ExecutionPayload ordering, universalDeploy/PublicKeys.default fixity, secret non-logging — Codex C3 traced fail-closed; not findings.
- `get_bridge_gas_msg_hash` hand-duplicated protocol mirror with no static parity check on version bumps — fails closed (DoS not theft) + covered by mandatory E2E CI; non-finding structural observation only.

## Cross-cutting observations
1. **Zero active Noir unit coverage on the three fund-moving entrypoints** (`pay_fee`/`mint`/`mint_and_pay_fee` TXE tests all commented-out BLOCKED — TXE can't seed a FeeJuice nullifier / has zero gas / `end_setup()` breaks kernel sim). They're covered only by `private.test.ts` integration (needs a live network; `mint_and_pay_fee` only by the assertion-less benchmark). Not a vulnerability, but the fastest test tier for the most security-critical logic is disabled — worth a fixture/mock-oracle harness so these get unit coverage. (Feeds the roadmap's "structural test debt" item.)
2. **Client-side trust in the RPC node** (F-001) is the one recurring real-world exposure; the contract-side math is solid. The SDK's threat model should treat the node as untrusted and give integrators the caps to enforce that.
