# C4 — TS network/artifact trust surface + packaging surface (Claude)

Package: `@alejoamiras/aztec-fee-payment@5.0.1`
Scope: `src/ts/artifactRegistry.ts`, `scripts/upload-artifact.ts`, `src/ts/utils/gas.ts`, `package.json` packaging surface.

Reachability method: repo-wide grep for every exported symbol in `artifactRegistry.ts`
(`fetchArtifactFromRegistry`, `loadArtifactWithRegistryFallback`, `uploadArtifactToRegistry`,
`uploadArtifactFileToRegistry`, `maybeUploadArtifactToRegistry`) across `packages/aztec-fee-payment`
and the whole monorepo, cross-checked against `src/ts/index.ts` / `src/ts/utils/index.ts` public
exports, `package.json` `"exports"`, `tsconfig.build.json` `include`, and `.github/workflows/*`.

---

## Finding 1 — Untrusted network artifact cast to `NoirCompiledContract` with zero validation, but the download path is dead code (unreachable from any caller in this repo)

**Impact factors (no CVSS):**
- Confidentiality: none directly.
- Integrity: total, *if reached* — a poisoned artifact becomes the contract ABI/bytecode a consumer instantiates (`loadContractArtifact`), which drives address derivation and call encoding. A wrong/malicious artifact → wrong contract address (funds/bridge claims sent to the wrong place) or an attacker-chosen ABI executed against a real address.
- Availability: none directly (fetch failures fall back to local file or throw).
- Blast radius: would be per-consumer-process, *if* any code called it. As shipped in this package, **no code calls it** — see Trace.
- Exploitability: **LOW in this SDK version** — the vulnerable code path is unreachable/dead. Rated as a live finding because the code is exported, ships in `dist`, and has zero test coverage, so a future patch/refactor could wire it in without anyone noticing the missing validation.

**Evidence confidence:** High (grep-verified: the two functions that perform the trust-relevant work, `fetchArtifactFromRegistry` and `loadArtifactWithRegistryFallback`, have no callers anywhere in the monorepo — not in `src/ts/index.ts`, `src/ts/utils/deploy.ts`, `benchmarks/*`, any `*.test.ts`, or any `.github/workflows/*`).

**OWASP/CWE mapping:** CWE-494 (Download of Code Without Integrity Check), CWE-345 (Insufficient Verification of Data Authenticity); OWASP A08:2021 (Software and Data Integrity Failures).

**Trace:**
- `src/ts/artifactRegistry.ts:107-125` — `fetchArtifactFromRegistry`: `const text = await res.text(); return safeJsonParse(text);` — returns `unknown` (or a raw string on parse failure) with no shape check.
- `src/ts/artifactRegistry.ts:131-169` — `loadArtifactWithRegistryFallback`: `return artifact as NoirCompiledContract;` (line 143) — a bare type assertion, no `zod` schema check (the package already depends on `zod@^4.4.0` in `devDependencies` — unused for this purpose), no hash pin, no signature check against `classId`.
- Confirmed dead: `grep -rn "loadArtifactWithRegistryFallback\|fetchArtifactFromRegistry" --include="*.ts" .` (repo root) returns only the definition sites in `artifactRegistry.ts` itself — zero call sites anywhere else in the monorepo, including `scripts/upload-artifact.ts` (which only imports the *upload* functions, not these).
- Not documented: `README.md` / `src/ts/README.md` / `docs/private-product-requirements.md` never mention the registry at all.
- Not tested: no `*.test.ts` file references "registry".

**Missing control:** schema validation (e.g. `zod`, already a devDependency) of the fetched JSON before casting to `NoirCompiledContract`; no `classId`-derived hash check against the fetched bytecode (the one control that would actually bind "the artifact I asked for by classId" to "the artifact I got"); no signature/provenance check on registry responses.

**Exploit/violation scenario (conditional on future reachability):** operator points `AZTEC_ARTIFACT_REGISTRY_URL` at (or the registry itself is compromised at) a host that returns a crafted JSON blob for a given `classId`. A caller of `loadArtifactWithRegistryFallback` gets that blob back as a trusted `NoirCompiledContract`, derives a contract address from it, and users bridge Fee Juice / interact with that address — funds go to whatever the attacker's artifact resolves to, or the attacker's chosen private function selectors get executed against a real deployed instance if only the ABI (not bytecode identity) is what downstream code trusts.

**Preconditions:** (a) some future or external code must actually call `loadArtifactWithRegistryFallback`/`fetchArtifactFromRegistry` — not true today; (b) attacker controls the registry response for the requested `classId` (compromised registry, or env-var redirection — see Finding 2).

**Why mitigations fail:** there are none in the reachable code path today (there is no reachable code path). `isStrictUpload()` (`AZTEC_ARTIFACT_REGISTRY_STRICT`) is the only "strict mode" flag in this file, and it governs upload error-swallowing only (`maybeUploadArtifactToRegistry`, itself also uncalled) — it has no effect whatsoever on the fetch/download path; there is no equivalent "strict fetch" control, so even if this were wired in, there is no config knob to make it fail closed on validation.

**Instances:** 1 (the fetch+cast pair, currently orphaned).

---

## Finding 2 — Artifact-registry upload path: env-controlled URL, no TLS enforcement, no auth/signing, redirects followed by default (dev-CLI-only)

**Impact factors:**
- Confidentiality: low — the uploaded payload is a compiled Noir contract artifact (ABI + bytecode), not a secret; nothing sensitive (tokens, keys) is attached to the request.
- Integrity: the *upload* has no authentication or signing at all — `uploadArtifactToRegistry` sends a bare multipart POST with no `Authorization` header, no request signing, no proof the uploader is who they claim. Anyone who can reach the registry can upload under any filename.
- Availability: n/a.
- Blast radius: bounded to whoever runs the CLI script and whatever registry accepts the upload.
- Exploitability: **LOW** — the only real caller is `scripts/upload-artifact.ts`, a manual developer CLI (`bun run upload:artifacts`). Confirmed **not** wired into `release.yml`, `_pr-benchmark.yml`, or `_update-baseline.yml` — the only `upload-artifact` hits in `.github/workflows/*` are the unrelated built-in `actions/upload-artifact@v4/v6` CI action, not this script.

**Evidence confidence:** High.

**OWASP/CWE mapping:** CWE-918 (Server-Side Request Forgery) for the env-controlled destination; CWE-306 (Missing Authentication for Critical Function) for the unauthenticated upload; OWASP A08:2021 / A05:2021.

**Trace:**
- `src/ts/artifactRegistry.ts:27-29` — `getArtifactRegistryBaseUrl()` returns `process.env.AZTEC_ARTIFACT_REGISTRY_URL` verbatim if set, no scheme allowlist, no hostname allowlist.
- `src/ts/artifactRegistry.ts:46-53` — `new URL('api/upload', base)` then `fetch(uploadUrl, { method: 'POST', body })` — plain `fetch`, no `redirect: 'manual'`, so Node's default (`follow`) is used; no TLS/cert pinning; `http://` is accepted equally to `https://` since nothing checks `base.protocol`.
- `src/ts/artifactRegistry.ts:41-53` — no `Authorization`/API-key header anywhere in the upload request.
- `scripts/upload-artifact.ts:14` — CLI reads the same env var and passes it straight through; the file's own header comment ("The registry typically verifies the artifact's classId exists on the target network") documents an *assumption* the client code does nothing to enforce or verify.

**Missing control:** scheme allowlist (`https:` only) on `getArtifactRegistryBaseUrl()`; explicit `redirect: 'manual'` (or an allowlisted-host check post-redirect); any form of request authentication/signing.

**Exploit/violation scenario:** an attacker who can set/influence `AZTEC_ARTIFACT_REGISTRY_URL` in a developer's or CI's environment (e.g. via a compromised `.env`, a malicious PR that changes a CI env default, or a compromised dependency that mutates `process.env`) redirects the upload target to an attacker-controlled host, silently exfiltrating the compiled artifact (low sensitivity) or — more relevant if Finding 1 is ever wired in — serving back a poisoned artifact when the same env var is later used for the fetch/fallback path (both functions share `getArtifactRegistryBaseUrl()`).

**Preconditions:** attacker needs environment/CI control over `AZTEC_ARTIFACT_REGISTRY_URL`, or control of the DNS/network path to `devnet.aztec-registry.xyz` (unencrypted MITM is moot since default is `https:`, but nothing *forces* `https:` if an operator or attacker sets an `http://` override). Requires a human (or a future automated job) to actually run `scripts/upload-artifact.ts`.

**Why mitigations fail:** `isStrictUpload()` only decides whether a failed upload throws vs. warns-and-continues (`src/ts/artifactRegistry.ts:96-104`) — it is not a security control, it does not validate the destination, and does not affect whether the request itself is authenticated or redirect-safe.

**Instances:** 1 (shared `getArtifactRegistryBaseUrl()` feeds both upload and fetch call sites).

---

## Finding 3 — `estimateGasSettings` places unbounded trust in node-reported gas parameters; combined with the FPC's no-refund design this is real (not merely cosmetic) fund-loss exposure to a malicious/compromised RPC node — production-reachable

**Impact factors:**
- Confidentiality: none.
- Integrity: the client accepts `aztecNode.getCurrentMinFees()` and `aztecNode.getNodeInfo().txsLimits.gas` with no upper-bound/sanity check, and uses both to compute the transaction's declared `GasSettings` (`maxFeesPerGas`, `gasLimits`). Traced the on-chain side: `fpc_lib/src/lib.nr:17-27` `get_max_gas_cost()` recomputes `max_fee_per_da_gas * da_gas_limit + max_fee_per_l2_gas * l2_gas_limit` from `context.gas_settings()` — i.e. from the **same client-declared values**, not from an independent network-observed price. `private_contract/src/main.nr:47-58` `pay_fee()` calls `_deduct_max_gas_cost` and is explicitly commented `/// @dev Does not refund unused gas - the full max_gas_cost is consumed.` So an inflated client-side estimate is not just a "declared ceiling that's rarely charged" — for this FPC it is quite literally the amount permanently deducted from the user's private balance, with no refund path (by design — refunds aren't possible privately here).
- Availability: a sufficiently inflated `txsLimits.gas` bound could also make `padAndClampGas` (gas.ts:97-103) clamp to a nonsensically large "max", removing the one bound that theoretically protects against a garbage `getCurrentMinFees()` value, since **both signals come from the same untrusted node** — there is no independent ceiling anywhere in this file.
- Blast radius: bounded to the signer of each transaction (GasSettings is per-tx, not shared state) — **not** cross-user in the sense of one user draining another's balance. However, blast radius scales with how many users share the same (compromised/malicious) RPC endpoint: every user of a dApp routed through that node on every tx is affected identically, so "self-only" undersells it when the node is a shared public endpoint.
- Exploitability: **MODERATE, and production-reachable** — `estimateGasSettings` and `maxGasCostFor` are part of the package's public API (`src/ts/index.ts:42,44`, re-exported from `./utils`) and are exercised in `benchmarks/private.benchmark.ts:157,166`; this is exactly the code path SDK integrators are expected to call before every fee-paying transaction. Precondition is a malicious/compromised `aztecNode` (an untrusted or hostile RPC provider) — a realistic, well-precedented threat model in the broader Web3/RPC-provider space, not a hypothetical.

**Evidence confidence:** High (both the TS estimator and the Noir-side recomputation were read directly; the "no refund" comment is explicit in the contract source).

**OWASP/CWE mapping:** CWE-20 (Improper Input Validation) / CWE-345 (Insufficient Verification of Data Authenticity) applied to a trusted-infrastructure dependency; OWASP A08:2021 (Software and Data Integrity Failures) — closest fit, acknowledging this is a design/trust-boundary gap rather than a classic injection bug.

**Trace:**
- `src/ts/utils/gas.ts:189` — `const maxFeesPerGas = maxFeesPerGasFromBaseFees(await aztecNode.getCurrentMinFees(), maxFeeMultiplier);` — no bound on the magnitude of `getCurrentMinFees()`'s return value; only a fixed `6/5` multiplier (`DEFAULT_FEE_MULTIPLIER`, gas.ts:82-85) is applied on top of whatever the node reports.
- `src/ts/utils/gas.ts:192-195` — `const { txsLimits: { gas } } = await aztecNode.getNodeInfo();` then used directly as `maxGasLimits`, the very value later used to *clamp* the padded estimate (gas.ts:97-103) — i.e. the "safety clamp" is sourced from the same untrusted party as the thing it's supposed to bound.
- `src/ts/utils/gas.ts:185-187` — the only validation present (`estimatedGasPadding` must be finite and `>= 0`) guards against `NaN`/negative padding, not against the magnitude of the untrusted base values it's applied to.
- `packages/aztec-fee-payment/src/nr/fpc_lib/src/lib.nr:17-27` — `get_max_gas_cost` derives cost from `context.gas_settings()`, the tx's own declared settings.
- `packages/aztec-fee-payment/src/nr/private_contract/src/main.nr:47-58` — `pay_fee()`, comment: "Does not refund unused gas - the full max_gas_cost is consumed."

**Missing control:** an absolute sanity ceiling (e.g. a caller-configurable max fee-per-gas / max total cost cap, checked client-side before simulating/sending) independent of anything the connected node reports; today the only guard against gross overpay is the caller's own judgement — the SDK provides no `maxAcceptableGasCost` parameter for `estimateGasSettings` to enforce.

**Exploit/violation scenario:** a user connects to a malicious or compromised Aztec node/RPC endpoint (their own misconfigured node, a public shared sequencer/RPC service that's been compromised, or a MITM'd connection). That node returns a `getCurrentMinFees()` value orders of magnitude above the real network rate (and/or an inflated `txsLimits.gas`). `estimateGasSettings` faithfully turns this into `GasSettings` with a correspondingly inflated `maxFeesPerGas`/`gasLimits`; the resulting transaction is signed and sent with those settings; on-chain, `pay_fee()`/`mint_and_pay_fee()` deduct the full (inflated) `max_gas_cost` from the user's private FPC balance with no refund — a real, permanent loss up to the user's entire minted balance, not a bounded "declared ceiling that's rarely actually charged."

**Preconditions:** attacker controls or has compromised the `aztecNode` endpoint the SDK consumer is connected to (or sits on-path and can tamper with its RPC responses without triggering transport-level integrity failure — out of scope for this file, but nothing here would detect it either way).

**Why mitigations fail:** the `maxFeeMultiplier`/`estimatedGasPadding` validation (gas.ts:58-59, 68-72, 185-187) only rejects malformed *multiplier/padding* inputs supplied by the *caller* — it does nothing to validate the *base* values supplied by the node, which is the actual untrusted input in this threat model. The gas-limit "clamp" (`padAndClampGas` against `maxGasLimits`) is not an independent check either, since `maxGasLimits` itself comes from the same node.

**Instances:** 1 (both `getCurrentMinFees()` and `getNodeInfo().txsLimits.gas` consumed with no independent bound, in the one function that computes on-chain-consumed `GasSettings`).

---

## Finding 4 — Packaging ships fully-functional, unexported code (`artifactRegistry.ts` + the test-only `CounterContract` binding + its 1.2MB raw artifact) reachable only via non-standard deep import

**Impact factors:**
- Confidentiality/Integrity/Availability: none directly — nothing here is a secret, and none of it is auto-invoked by installing the package.
- Blast radius: attack-surface widening / dependency-review noise, not a direct exploit. Primarily relevant to (a) trust-boundary confusion for anyone auditing the dependency, (b) forward risk that this orphaned, untested, unreviewed-as-production code gets wired into a real path later without a fresh security pass (ties back to Finding 1), and (c) a test-only, unaudited-for-production contract (`CounterContract`) being fully deployable under the same package name/trust umbrella as the audited `PrivateFPC`.
- Exploitability: **LOW** — Node's ESM `"exports"` field (present in this `package.json`, `"type": "module"`) blocks conventional `import`/`require` resolution of any path not listed (`.`, `./artifacts/private`, `./fee-payment-methods`, `./utils`, `./package.json`). Reaching the unexported files requires deliberately bypassing package resolution (a hardcoded deep file path, a bundler that doesn't enforce `exports`, or reading straight off disk in `node_modules`) — this is "technically present, not technically importable through the normal API," not a bypassable access control.

**Evidence confidence:** High (verified via `npm pack --dry-run` reasoning + direct inspection of `tsconfig.build.json` `include` and `package.json` `"files"`/`"exports"`).

**OWASP/CWE mapping:** closest fits are CWE-749 (Exposed Dangerous Method or Function) for the fully-deployable `CounterContract.deploy()`/`.at()` shipping un-exported, and OWASP A05:2021 (Security Misconfiguration) / A08:2021 (Software Supply Chain) for shipping unreviewed-for-production, undocumented code in a published security-relevant package; no CWE maps cleanly onto "pure bloat," which is why the raw-JSON-only bloat is rated separately below and kept low.

**Trace:**
- `package.json:34-39` — `"files": ["dist", "target", "!target/*.json.bak", "canonical-deployment.json"]` whitelists the *entire* `dist` and `target` directories wholesale; there is no per-file curation inside those.
- `package.json:13-31` `"exports"` map only lists `.`, `./artifacts/private`, `./fee-payment-methods`, `./utils`, `./package.json` — `artifactRegistry.js` and `Counter.js` are not listed.
- `tsconfig.build.json:9-15` — `"include"` explicitly lists `"src/ts/artifactRegistry.ts"` and the wildcard `"src/artifacts/**/*"` (which also picks up `Counter.ts`, not just `PrivateFPC.ts`) — confirming both compile into `dist/` and ship, since `dist` is whitelisted wholesale.
- `src/artifacts/Counter.ts:9` — `import CounterContractArtifactJson from '../../target/counter_contract-Counter.json' with { type: 'json' };` plus a fully implemented `CounterContract` class with static `.deploy()` (line ~45) and `.at()` — this is not inert data, it is a complete, deployable contract binding for a **test/benchmark-only** contract (per `packages/aztec-fee-payment/CLAUDE.md`: `counter_contract` — "Test utility contract for benchmarks and integration tests"), shipped with no README/docs disclosure that it is not intended for production use.
- Confirmed via `npm pack --dry-run` (run with `dist/` absent from the worktree) that `target/counter_contract-Counter.json` (1.2MB, test-only artifact) and `target/private_contract-PrivateFPC.json` (2.4MB) both land in the tarball; a real release (`bun run build` runs first) additionally adds `dist/src/artifacts/Counter.js` + `.d.ts` and `dist/src/ts/artifactRegistry.js` + `.d.ts`, none of which are reachable via the `"exports"` map.

**Missing control:** curate `"files"`/an `.npmignore` to exclude `dist/src/ts/artifactRegistry.*` and `dist/src/artifacts/Counter.*` (and drop `target/counter_contract-Counter.json` from the tarball, or scope it under a clearly-named `test-fixtures/` path with a README caveat) so unexported modules don't ship at all; alternatively, add both to a `"exports"` entry that documents them as unsupported/internal, or delete `artifactRegistry.ts` entirely if genuinely unused (per Finding 1/2, nothing in this repo calls its download path or its upload wrapper's safe variant).

**Exploit/violation scenario:** low-severity, presented honestly as attack-surface/hygiene rather than a bypass: (1) a dependency-review/SCA tool or a curious integrator finds `CounterContract` shipped inside `@alejoamiras/aztec-fee-payment` (a package whose stated purpose is FPC fee sponsorship), assumes it is a supported/audited contract because it ships under that trust umbrella, and deploys or builds on it — inheriting whatever gaps exist in benchmark-grade code never hardened for production; (2) the `.d.ts` for `artifactRegistry` ships too, so IDE auto-import or a CDN browser (unpkg/jsdelivr) can surface `loadArtifactWithRegistryFallback` to a consumer who then wires it into their own production code, inheriting Finding 1's validation gap under the mistaken belief it's a supported/reviewed part of the SDK.

**Preconditions:** consumer must deliberately deep-import an unexported path, or use tooling that reads package contents without going through `"exports"` enforcement (bundlers vary; direct `node_modules` inspection always works, since it's just files on disk once installed).

**Why mitigations fail:** the `"exports"` map is real hardening against *accidental* imports via the normal `import '@alejoamiras/aztec-fee-payment/...'` surface, but provides zero protection against the files existing in the installed package at all — it is a resolution-time gate, not a packaging-time exclusion, so anything security- or trust-sensitive about *shipping* the code (dependency-review noise, CDN discoverability of the `.d.ts`, deep-import-by-path) is unaffected by it.

**Instances:** 3 shipped-but-unexported artifacts — `dist/src/ts/artifactRegistry.js`(+`.d.ts`), `dist/src/artifacts/Counter.js`(+`.d.ts`), `target/counter_contract-Counter.json` (raw, 1.2MB, test-only bytecode/ABI — this instance is pure bloat with no functional deep-import concern since it's plain JSON data, not code; included for completeness per task instructions but rated lowest of the three).

---

## Summary

| # | Finding | Prod-reachable? | Exploitability |
|---|---|---|---|
| 1 | Unvalidated artifact fetch cast to `NoirCompiledContract` | No — dead code, zero callers repo-wide | Low (today); real gap if ever wired in |
| 2 | Registry upload: env-controlled URL, no auth, redirects followed | Dev-CLI only (`scripts/upload-artifact.ts`), not in CI/release | Low |
| 3 | `estimateGasSettings` unbounded trust in node-reported gas + no-refund FPC | Yes — public API, used in benchmarks, integrator-facing | Moderate |
| 4 | Packaging ships unexported `artifactRegistry`/`Counter` binding + test artifact | Only via non-standard deep import | Low |
