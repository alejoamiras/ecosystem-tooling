# C4 — TypeScript network trust and npm packaging

## Result

**1 security finding.** The untrusted artifact loader is not production-wired through the published package API; the production-reachable issue is uncapped node-derived fee settings interacting with the FPC's no-refund accounting.

## C4-1 — A malicious RPC node can make the no-refund FPC debit an attacker-chosen maximum fee

### Impact factors

- **Confidentiality:** none.
- **Integrity:** a user's private FPC ledger balance can be reduced by an inflated maximum gas cost rather than a reasonable network-derived amount. If the connected node is also the submitting sequencer, overly generous fee caps can additionally permit excessive fee charging; at minimum, the FPC's own no-refund accounting consumes the declared maximum.
- **Availability:** the node can choose values that exhaust the user's internal balance or make `pay_fee` / `mint_and_pay_fee` fail, preventing sponsored transactions.
- **Blast radius:** users/applications that call the root-exported `estimateGasSettings` with the malicious or compromised node and then submit those returned settings. Harm is per signing user/transaction, not automatic cross-user corruption. The FPC's public pool is not directly drained solely by the estimator; the clearest harm is self-overpay/internal-credit destruction.
- **Exploitability:** **PROD-WIRED.** `estimateGasSettings` is exported from the package root (`src/ts/index.ts:38-47`). Exploitation requires control of, compromise of, or DNS/TLS-level substitution for the Aztec RPC endpoint selected by the application, plus the application using the returned settings without an independent cap or confirmation. A malicious node should keep advertised gas limits admissible and inflate fees within representable bounds; absurd values instead fail closed.

### Evidence confidence

**High.** The dataflow is direct in TypeScript and terminates in the audited Noir fee formula. No inference from dead/test code is required.

### OWASP/CWE mapping

- OWASP Top 10 2021: **A08 — Software and Data Integrity Failures** (security-relevant node data accepted without an independent trust/integrity policy).
- **CWE-20 — Improper Input Validation** (no application-level ceiling or reasonableness bound on node-supplied fees).

### Trace

1. A production consumer imports `estimateGasSettings` from the root export (`src/ts/index.ts:38-47`).
2. The helper accepts an application-supplied `GasEstimationNode` (`src/ts/utils/gas.ts:163-179`).
3. It trusts `aztecNode.getCurrentMinFees()` and multiplies both node values into `maxFeesPerGas` (`gas.ts:111-123,189-190`). There is positivity validation for the multiplier, but no absolute fee ceiling.
4. It separately trusts `getNodeInfo().txsLimits.gas` as both simulation limits (`gas.ts:192-209`) and the upper clamp for returned transaction limits (`gas.ts:226-233`).
5. The resulting `GasSettings` are returned to the consumer (`gas.ts:228-233`) and are therefore the declared transaction settings when used for submission.
6. The production fee method invokes the FPC's `pay_fee()` (`src/ts/fee-payment-methods/shared.ts:23-41`). The FPC deducts `max_gas_cost` and provides no refund (`src/nr/private_contract/src/main.nr:46-58`).
7. On-chain `get_max_gas_cost` recomputes from the transaction's declared `gas_limits × max_fees_per_gas` (`src/nr/fpc_lib/src/lib.nr:17-26`). This protects against a mismatch between the estimate and declared settings, but it does **not** correct maliciously inflated declared settings; it makes those settings authoritative for the FPC debit.

### Missing control

No caller-configurable absolute ceiling, maximum total fee budget, comparison against a second trusted fee source, or mandatory confirmation boundary exists before node-derived values become returned `GasSettings`. `estimatedGasPadding` is validated (`gas.ts:181-187`), but that validation does not constrain node-supplied fees.

### Exploit/violation scenario

A wallet uses an Aztec RPC endpoint supplied by its deployment environment and calls `estimateGasSettings` before sending a transaction with `FPCFeePaymentMethod`. An attacker controlling that endpoint returns plausible admission gas limits but inflated `getCurrentMinFees` values. The SDK multiplies them by 1.2, mirrors them into priority caps, and returns them. The wallet submits the transaction. `pay_fee()` computes the maximum from those signed settings and removes that full amount from the user's internal balance without refund, even if actual execution needed far less gas. Repeating this on user-approved transactions exhausts the user's FPC credit; values above the balance instead create a reliable sponsored-transaction denial.

### Preconditions

- The consumer uses `estimateGasSettings` and applies its result to the transaction.
- The attacker controls or can substitute the consumer's Aztec node/RPC responses.
- For balance destruction rather than a revert, the inflated maximum remains within protocol representations/admission rules and within the user's available internal balance.

### Why mitigations fail

- The 1.2 multiplier is a floor-increasing policy, not a cap (`gas.ts:38-40,77-85,189`).
- `padAndClampGas` clamps only to another value supplied by the same node (`gas.ts:97-103,192-195,228-230`).
- The `totalGas` admission check also compares against that same node value (`gas.ts:218-223`).
- On-chain recomputation prevents the SDK from lying about the declared settings, but the attack places the inflated values in those declared settings; the FPC intentionally charges their maximum and does not refund (`src/nr/fpc_lib/src/lib.nr:17-26`; `src/nr/private_contract/src/main.nr:46-58`).

### Instances

- `packages/aztec-fee-payment/src/ts/utils/gas.ts:111-123,163-234`
- `packages/aztec-fee-payment/src/ts/index.ts:38-47`
- `packages/aztec-fee-payment/src/ts/fee-payment-methods/shared.ts:23-41`
- `packages/aztec-fee-payment/src/nr/private_contract/src/main.nr:46-58,98-107`
- `packages/aztec-fee-payment/src/nr/fpc_lib/src/lib.nr:17-26`

## Untrusted artifact registry — non-finding due to production reachability

The sharp primitive is real in isolation: registry JSON is parsed and cast to `NoirCompiledContract` without schema, class-id/hash, or signature verification (`src/ts/artifactRegistry.ts:107-124,131-169`). Registry-first behavior means a valid response wins over the local artifact (`artifactRegistry.ts:136-151`). If production contract construction consumed it, registry compromise could replace ABI/bytecode and therefore contract identity/address.

That sink is **not production-wired in 5.0.1**:

- Repository-wide call-site tracing found no caller of `fetchArtifactFromRegistry` or `loadArtifactWithRegistryFallback`; the only external registry caller is the upload script (`scripts/upload-artifact.ts:1-19`).
- `artifactRegistry.ts` is compiled because `tsconfig.build.json:8-14` includes it, but neither the package root nor any exported subpath re-exports it (`package.json:13-30`; `src/ts/index.ts:25-48`).
- Node's package-exports enforcement rejects `@alejoamiras/aztec-fee-payment/dist/src/ts/artifactRegistry.js` with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Reaching it requires bypassing the package API with a filesystem/absolute-path import or tooling that ignores `exports`; code already able to select arbitrary files from `node_modules` does not gain a new ambient production path.
- `AZTEC_ARTIFACT_REGISTRY_STRICT` controls **upload failure handling only** (`artifactRegistry.ts:36-39,90-104`). It neither validates fetched artifacts nor makes fetches strict, so it would not mitigate poisoning if a future production caller were added. At present there is no such caller.

The environment-set base URL permits HTTP, loopback/link-local hosts, credentials, and normal `fetch` redirects (`artifactRegistry.ts:23-28,46-53,111-114`). That is an SSRF-capable primitive only when an attacker can influence the environment or explicit `registryBaseUrl` of code that calls it. In this release the fetch path has no public production caller and the upload path is an operator-invoked development/release script, so no in-scope production SSRF trace exists. The default uses TLS (`artifactRegistry.ts:28`).

Registry error handling does not log artifact bodies or bridge secrets. Upload errors may include the registry's response text (`artifactRegistry.ts:55-72,96-103`), and the upload script prints the selected local path and base URL (`scripts/upload-artifact.ts:27-36`); these are operator/release metadata, not SDK secret material.

## Packaging confirmation — informational only

`package.json:34-39` includes all of `target` and excludes only `*.json.bak`. `npm pack --dry-run --json` confirmed that the 5.0.1 tarball contains:

- `target/counter_contract-Counter.json` — 1,209,208 bytes;
- `target/private_contract-PrivateFPC.json` — 2,389,400 bytes; and
- neither `.json.bak` file.

The dry run reported a 3,608,374-byte unpacked package before locally absent `dist` output. The Counter artifact is not in the exports map, and the generated Counter binding is likewise not exported. This is unintended shipped test surface and material bloat, but no production execution/import path or secret was found; it is therefore not rated as a security finding.

