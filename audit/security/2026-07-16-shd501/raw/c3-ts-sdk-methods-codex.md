# C3 — TypeScript SDK methods and address derivation

## Result

**0 security findings.** I found test/control gaps, but no current production exploit trace that satisfies the audit bar.

## Address-derivation integrity

- The production registration helper always supplies `salt` and `universalDeploy: true`; there is no branch or caller-controlled flag that can make it false (`src/ts/utils/deploy.ts:23-27`). In Aztec 5.0.1 this selects the universal deploy path, whose address preimage uses the zero deployer.
- The independent computation uses the same artifact, empty constructor arguments, caller-supplied salt, `PublicKeys.default()`, and `AztecAddress.ZERO` (`scripts/compute.ts:22-29`). The canonical test repeats those exact parameters (`src/ts/test/canonical.test.ts:28-35`). The generated wrapper has no constructor parameters and its helper passes `args: []` (`src/artifacts/PrivateFPC.ts:50-59`); its only declared storage slot is `balances` at slot 1 (`src/artifacts/PrivateFPC.ts:98-104`).
- `PublicKeys.default()` cannot be overridden through `registerPrivateContract`; the helper supplies no `publicKeys` option and Aztec dependencies are exact-pinned to 5.0.1 (`package.json:57-67,78-81`). A consumer can deliberately call the separately exported generated `PrivateFPCContract.deploy(...)` API with other instantiation parameters (`src/artifacts/PrivateFPC.ts:47-59`), but that is an explicit low-level choice, not a silent alternate path in the canonical helper.
- A noncanonical salt deliberately yields another valid instance address. Both `registerPrivateContract` and `scripts/compute.ts` accept such a salt, and the README explicitly labels this supported (`README.md:75-94`). This is not by itself a wrong-address exploit: callers that fund the returned/computed address can register the same private artifact there.

### Is `canonical.test.ts` sufficient as a fund-loss guard?

It is sufficient for the three stale-data properties it claims to enforce:

1. canonical Aztec version equals the exact package pin (`src/ts/test/canonical.test.ts:22-26`);
2. canonical address equals artifact + canonical salt + default keys + zero deployer (`src/ts/test/canonical.test.ts:28-36`); and
3. the specifically displayed README “Current canonical” line contains that address (`src/ts/test/canonical.test.ts:38-47`).

It does **not** execute `registerPrivateContract`, so a future edit that removed `universalDeploy: true` could leave this test green. That is a test-coverage gap, not a current finding: the audited production helper is unconditional and matches the tested derivation. The focused test run could not execute native hash/selector calculations in this sandbox because the bb native backend exited; the two non-native canonical assertions passed, and the source-level traces above establish the current parameter equality.

## Hand-encoded selectors and payload binding

- The production strings are `claim((Field),u128,Field,Field)` (`src/ts/fee-payment-methods/private.ts:47-55`), `mint_and_pay_fee(u128,Field,Field)` (`private.ts:57-65`), and `pay_fee()` (`src/ts/fee-payment-methods/shared.ts:24-35`). They match the current generated/local ABIs and the pinned FeeJuice ABI as encoded in `src/ts/test/selectors.test.ts:14-32`.
- The selector test duplicates the production literals instead of importing/deriving the actual production selector, so it catches ABI drift but would not catch an isolated typo in a production literal. No present mismatch exists. A mismatch is fail-closed: it targets no matching private function and causes proving/execution failure; the claim and mint calls are one ordered `ExecutionPayload` (`private.ts:45-72`), so the first call cannot remain committed after failure of the second.
- The payload fixes ordering as FeeJuice `claim` followed by FPC `mint_and_pay_fee` (`private.ts:45-67`). The same `fpcAddress`, `amount`, and `leafIndex` are supplied to both calls (`private.ts:54,64`), while `secret` goes only to FeeJuice and `salt` only to the FPC, as required by the nullifier derivation. Caller-controlled values are checked by the FeeJuice claim and by the FPC's asserted FeeJuice nullifier; the transaction gas settings, not any constructor argument, determine `max_gas_cost`. `new Fr(amount)` may reject or encode an out-of-range value, but it cannot make the two bundled calls disagree because both receive the same encoding (`private.ts:54,64`).

## Secret handling

The `secret` and `salt` are TypeScript `private` parameter properties (`src/ts/fee-payment-methods/private.ts:25-32`), so emitted JavaScript retains enumerable properties. Runtime inspection confirmed that logging the payment-method object displays both field values. However, this package never logs, serializes, or includes the payment-method object in an error; it only reads the fields into the private execution payload (`private.ts:42-72`). Ordinary `JSON.stringify` also fails on the adjacent `bigint` before producing output. Because there is no package-controlled disclosure sink, this does not meet the requested concrete exploit-path threshold. Applications must still treat transaction-option objects containing bridge claims as sensitive and avoid logging them.

## Instances reviewed

- `packages/aztec-fee-payment/src/ts/fee-payment-methods/private.ts`
- `packages/aztec-fee-payment/src/ts/fee-payment-methods/shared.ts`
- `packages/aztec-fee-payment/src/ts/utils/deploy.ts`
- `packages/aztec-fee-payment/src/ts/index.ts`
- `packages/aztec-fee-payment/scripts/compute.ts`
- `packages/aztec-fee-payment/canonical-deployment.json`
- `packages/aztec-fee-payment/src/ts/test/canonical.test.ts`
- `packages/aztec-fee-payment/src/ts/test/selectors.test.ts`
- `packages/aztec-fee-payment/src/artifacts/PrivateFPC.ts`

