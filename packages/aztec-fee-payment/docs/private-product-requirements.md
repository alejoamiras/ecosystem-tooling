# Private FPC — Product Requirements Document

**Version**: 1.6
**Status**: Active
**Target Aztec Version**: 5.0.1
**Audience**: Implementation Engineers
**Date**: May 2026

---

## Problem Statement

Users bridging FeeJuice (FJ) from L1 into Aztec must deposit via `FeeJuicePortal`, claim FJ on L2, then acquire internal FJ to sponsor transactions. If the bridge recipient is the FPC, FJ lands in its public balance — but users need **private** FJ for `pay_fee()`. This PRD defines a flow where self-bridgers convert bridged FJ into internal FJ credit in a private L2 call, without new L1 infrastructure or public contract methods.

---

## Goals

1. **Self-bridge to internal balance**: Bridge to FPC address → single private L2 call → FJ credit.
2. **No new L1 logic**: Reuse `FeeJuicePortal` → `FeeJuice`; extend FPC only.
3. **Full privacy**: `mint` is private; no public validation call.
4. **Deterministic auth**: Secret derived from `(salt, claimer)`; `msg_sender` binds authorization.

---

## Non-Goals

1. **Refund flow**: No `pay_fee_exact()` / teardown / partial notes. Max gas cost is consumed in full.
2. **Owner / access control**: No owner address, no authwit-based minting, no off-chain agent.
3. **Class publishing**: The contract is fully private — no public functions, no class registration required.
4. **Partial minting**: Full `amount` in one call; no incremental crediting.

---

## User Stories

**As a user who bridged FJ to the FPC on L1**, I want internal FJ so I can sponsor transactions:

- L1: `FeeJuicePortal.depositToAztecPublic(_to=FPC, _amount, _secretHash)` where `_secretHash = compute_secret_hash([derive_bridge_secret(salt, claimer)])`
- L2 (can batch in same tx):
  - `FeeJuice.claim(FPC, amount, secret, leaf_index)`
  - `FPC.mint(amount, salt, leaf_index)` with my wallet

**As the FPC**, credit only when:

- Recipient = FPC address
- Bridge message already consumed by `FeeJuice.claim` (nullifier exists)
- Caller = authorized claimer (matches the secret used in L1 deposit)
- Deposit not already minted (FPC nullifier not yet emitted)

---

## Requirements

| ID   | Requirement                       | Acceptance Criteria                                                                                                                                                                                                                                                                                          | Status  |
| ---- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| BR-1 | **Private `mint`**                | `mint(amount, salt, leaf_index)`; claimer = `msg_sender`. Fully private, no public call.                                                                                                                                                                                                                     | Planned |
| BR-2 | **Destination check**             | Content hash encodes recipient=FPC. Reconstruct `get_bridge_gas_msg_hash(FPC_address, amount)` — identical to `FeeJuicePortal` encoding.                                                                                                                                                                     | Planned |
| BR-3 | **Bridge claim proof**            | Assert FeeJuice nullifier exists via private `assert_nullifier_exists`. Supports pending (same-tx) and settled.                                                                                                                                                                                              | Planned |
| BR-4 | **Claimer auth**                  | `secretHash = compute_secret_hash([poseidon2([salt, claimer], DOM_SEP__FPC_BRIDGE_SECRET)])`; L1 deposit uses this hash. Only the claimer can reproduce the secret.                                                                                                                                            | Planned |
| BR-5 | **Double-spend prevention**       | FPC emits siloed nullifier (same raw value, siloed under FPC address); distinct from FeeJuice's siloed nullifier. Second `mint` call with same deposit fails.                                                                                                                                                | Planned |
| BR-6 | **Correct amount**                | `amount` must match the bridged amount exactly; mismatch yields a wrong nullifier that fails the existence check.                                                                                                                                                                                            | Planned |
| BR-7 | **Cold-start `mint_and_pay_fee`** | `mint_and_pay_fee(amount, salt, leaf_index)` combines bridge claim proof with fee payment in one call. Asserts `amount >= max_gas_cost`; credits `amount - max_gas_cost` to claimer; sets FPC as fee payer. Same security guarantees as `mint` (claimer auth, nullifier existence, double-spend prevention). | Planned |

### Noir Contract: Private FPC

| Requirement                                                 | Acceptance Criteria                                                                                                                                                                                                                                                                                                     | Status  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Storage**                                                 | `balances: Owned<BalanceSet<Context>>` only. No owner field, no `DelayedPublicMutable`.                                                                                                                                                                                                                                 | Planned |
| **Method: `pay_fee()`**                                     | Private, `#[allow_phase_change]`. Deducts max gas cost from `msg_sender`'s FJ balance via recursive `try_sub`; calls `set_as_fee_payer()` then `end_setup()`. No refund.                                                                                                                                                | Planned |
| **Method: `mint(amount, salt, leaf_index)`**                | Private. Derives `secret = poseidon2([salt, claimer], DOM_SEP)`; reconstructs FeeJuice claim nullifier; asserts existence; pushes FPC-scoped nullifier; mints `amount` to claimer with `ONCHAIN_UNCONSTRAINED` delivery.                                                                                                | Planned |
| **Method: `mint_and_pay_fee(amount, salt, leaf_index)`**    | Private, `#[allow_phase_change]`. Cold-start flow: same bridge claim proof as `mint`, but credits `amount - max_gas_cost` instead of full `amount`; asserts `amount >= max_gas_cost`; calls `set_as_fee_payer()` then `end_setup()`. Enables mint + fee sponsorship in a single transaction without prior FJ balance.   | Planned |
| **Method: `balance_of(account)`**                           | Unconstrained utility view. Returns the FJ balance of an account.                                                                                                                                                                                                                                                       | Planned |
| **Library: `derive_bridge_secret(salt, claimer)`**          | `#[contract_library_method]`. Returns `poseidon2_hash_with_separator([salt, claimer.to_field()], DOM_SEP__FPC_BRIDGE_SECRET)`.                                                                                                                                                                                          | Planned |
| **Library: `get_bridge_gas_msg_hash(fpc_address, amount)`** | `#[contract_library_method]`. Computes `sha256(selector[0:4] \|\| fpc \|\| amount)` where selector is `keccak256("claim(bytes32,uint256)")[0:4]` evaluated at comptime. Mirrors `FeeJuicePortal.depositToAztecPublic`.                                                                                                  | Planned |
| **Library: `compute_feejuice_claim_nullifier(...)`**        | `#[contract_library_method]`. Reconstructs the nullifier emitted by `FeeJuice.claim` for a given deposit. Uses `compute_l1_to_l2_message_hash` + `compute_l1_to_l2_message_nullifier`.                                                                                                                                  | Planned |
| **Library: `get_max_gas_cost(context)`**                    | `#[contract_library_method]` imported from shared `fpc_lib` package (same implementation as MeteredFPC). Corrected formula: `da_gas_limit * max_fee_per_da_gas + l2_gas_limit * max_fee_per_l2_gas`. Teardown gas limits are NOT added separately — the kernel's gas_meter already includes teardown within gas_limits. | Planned |
| **No public functions**                                     | Contract has zero public functions. Class does not need to be published/registered.                                                                                                                                                                                                                                     | Planned |

### TypeScript / Testing

| Requirement                                        | Acceptance Criteria                                                                                                                                                                                                                                                                                                                                                          | Status  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **`bridgeForMint` harness helper**                 | Computes bridge secret from `(salt, claimer)`, calls `depositToAztecPublic` with correct `secretHash`, polls for message ingestion, returns `{ secret, leafIndex, claimAmount }`.                                                                                                                                                                                            | Planned |
| **SDK gas-setting helper (`estimateGasSettings`)** | Sponsored transactions use `estimateGasSettings(interaction, { aztecNode, from, paymentMethod, … })`: it reads the network's per-tx admission limit from `aztecNode.getNodeInfo().txsLimits.gas`, runs `simulate({ includeMetadata: true })` within that ceiling and reads the raw `gasUsed` (`{ totalGas, teardownGas }`), pads the simulated usage client-side by `estimatedGasPadding` (default `0.1` = 10%; must be a non-negative finite number — the helper throws on `NaN`/`Infinity`/negative values before simulating, mirroring the `maxFeeMultiplier` validation), and clamps each dimension to the admission limit (throwing if simulated usage already exceeds it). Fee caps come from `aztecNode.getCurrentMinFees()` scaled by `1.2×` (exact `6/5`, ceiling), and `maxPriorityFeesPerGas` is set equal to `maxFeesPerGas`. An optional `maxAcceptableGasCost` (positive `bigint`, wei) caps the client-declared worst-case cost: when provided the helper throws if the projected max cost (`maxGasCostFor` over the returned `maxFeesPerGas` + padded `gasLimits`) exceeds it — an independent client-side ceiling that does not trust the node, since the FPC deducts the full max with no refund; when omitted a one-time `console.warn` nudges the caller to set one. | Planned |
| **E2E: `mint` success → `pay_fee`**                | Bridge → `FeeJuice.claim` → `mint` → sponsored transaction succeeds; FPC FJ balance decreases; user FJ balance decreases by max gas cost.                                                                                                                                                                                                                                    | Planned |
| **E2E: double-spend revert**                       | Second `mint` with same `leaf_index` reverts (FPC nullifier already exists).                                                                                                                                                                                                                                                                                                 | Planned |
| **E2E: wrong claimer revert**                      | Bob tries `mint` using Alice's deposit — reconstructed nullifier doesn't match; existence check fails.                                                                                                                                                                                                                                                                       | Planned |
| **`PrivateMintAndPayFeePaymentMethod`**            | `FeePaymentMethod` implementation that bundles `FeeJuice.claim` + `mint_and_pay_fee` in the setup phase. Cold-start flow: no prior `mint` needed. Constructor takes `(fpcAddress, amount, secret, salt, leafIndex)`.                                                                                                                                                         | Planned |
| **E2E: `mint_and_pay_fee` cold-start**             | Bridge → `FeeJuice.claim` + `mint_and_pay_fee` in one tx → sponsored tx succeeds; user FJ balance = `amount - max_gas_cost`.                                                                                                                                                                                                                                                 | Planned |

---

## Technical Design

### Actors

| Actor          | Layer | Description                                                 |
| -------------- | ----- | ----------------------------------------------------------- |
| **FJP**        | L1    | `FeeJuicePortal` — Solidity bridge; produces L1→L2 messages |
| **FJ**         | L2    | `FeeJuice` — Noir protocol contract; public FJ balances     |
| **PrivateFPC** | L2    | `PrivateFPC` — private FJ, fee sponsorship                  |
| **Claimer**    | —     | `msg_sender` of `mint`                                      |

### End-to-End Flow

```
L1:  FeeJuicePortal.depositToAztecPublic(_to=FPC, _amount, _secretHash)
     -> message { recipient: FeeJuice, content: sha256(claim(FPC,amount)), secretHash }

L2:  FeeJuice.claim(FPC, amount, secret, leaf_index)
     -> consume_l1_to_l2_message; emit nullifier; _increase_public_balance(FPC, amount)

     PrivateFPC.mint(amount, salt, leaf_index)  [msg_sender = claimer]
     -> assert_nullifier_exists(FeeJuice nullifier); push FPC nullifier; mint to claimer
```

`FeeJuice.claim` and `mint` can be batched in the same transaction. `compute_nullifier_existence_request` handles both pending (same-tx) and settled nullifiers.

### L1 Deposit

```solidity
// FeeJuicePortal.sol
function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash)
// contentHash = sha256(abi.encodeWithSignature("claim(bytes32,uint256)", _to, _amount))
// _secretHash = compute_secret_hash([derive_bridge_secret(salt, claimer_aztec_address)])
```

### Cryptographic Design

**Secret derivation**:

```
secret = poseidon2_hash_with_separator([salt, claimer.to_field()], DOM_SEP__FPC_BRIDGE_SECRET)
secretHash = compute_secret_hash([secret])
```

Domain separator (`poseidon2_hash_bytes("az_dom_sep__fpc_bridge_secret")` = `3952304070` / `0xEB935FC6`) avoids collisions with other poseidon2 usages. Only the claimer (the specific Aztec address) can reproduce the secret.

**Content hash** (mirrors `FeeJuicePortal`):

```
sha256(keccak256("claim(bytes32,uint256)")[0:4] || fpc_address_bytes32 || amount_bytes32)
```

The 4-byte selector is computed at compile-time via `comptime { keccak256::keccak256(...) }` — zero runtime cost.

**FeeJuice nullifier reconstruction**:

```
secret_hash = compute_secret_hash([secret])
message_hash = sha256(portal_eth_addr | chain_id | FEE_JUICE_L2_ADDR | version | content_hash | secret_hash | leaf_index)
feejuice_nullifier = poseidon2([message_hash, secret], DOM_SEP__MESSAGE_NULLIFIER)
```

Protocol invariant: FeeJuice portal Eth address = `EthAddress::from_field(FEE_JUICE_ADDRESS.to_field())`.

**Double-spend guard**: FPC emits the same raw `feejuice_nullifier` value siloed under the FPC address — distinct from FeeJuice's siloed version (siloed under `FEE_JUICE_ADDRESS`). Second `mint` call finds the FPC-scoped nullifier already exists and reverts.

**Existence check**: `compute_nullifier_existence_request(feejuice_nullifier, FEE_JUICE_ADDRESS)` uses an oracle hint to determine whether the nullifier is pending (in the same tx) or settled (in the nullifier tree). The kernel circuit verifies it.

### Contract Interface

```rust
#[aztec]
pub contract PrivateFPC {
    #[storage]
    struct Storage<Context> {
        balances: Owned<BalanceSet<Context>, Context>,
    }

    // Fee sponsorship
    #[external("private")]
    #[allow_phase_change]
    fn pay_fee() { ... }

    // Bridge claim mint
    #[external("private")]
    fn mint(amount: u128, salt: Field, leaf_index: Field) { ... }

    // Cold-start: bridge claim + fee payment in one call
    #[external("private")]
    #[allow_phase_change]
    fn mint_and_pay_fee(amount: u128, salt: Field, leaf_index: Field) { ... }

    // Internal balance helpers
    #[internal("private")]
    fn _deduct_max_gas_cost(account: AztecAddress) -> u128 { ... }

    #[internal("private")]
    fn _subtract_balance(account: AztecAddress, amount: u128, max_notes: u32) -> u128 { ... }

    #[external("private")]
    #[only_self]
    fn recurse_subtract_balance_internal(account: AztecAddress, amount: u128) -> u128 { ... }

    // View
    #[external("utility")]
    unconstrained fn balance_of(account: AztecAddress) -> u128 { ... }

    // Library methods
    #[contract_library_method]
    pub fn derive_bridge_secret(salt: Field, claimer: AztecAddress) -> Field { ... }

    #[contract_library_method]
    pub fn get_bridge_gas_msg_hash(fpc_address: AztecAddress, amount: u128) -> Field { ... }

    #[contract_library_method]
    pub fn compute_feejuice_claim_nullifier(...) -> Field { ... }

    #[contract_library_method]
    pub fn get_max_gas_cost(context: &mut PrivateContext) -> u128 { ... }
}
```

### Shared Library (`fpc_lib`)

`get_max_gas_cost` is not defined inline in PrivateFPC. It is imported from the shared `fpc_lib` Nargo library (`src/nr/fpc_lib/`), the same package used by MeteredFPC. This keeps the gas cost formula consistent across both FPCs and avoids duplication.

```toml
# PrivateFPC Nargo.toml
[dependencies]
fpc_lib = { path = "../fpc_lib" }
```

The method is annotated `#[contract_library_method]` and re-exported from PrivateFPC so callers can reference it via `PrivateFPC::get_max_gas_cost(context)`.

### Security Properties

| Property         | Mechanism                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Claimer auth     | `secret` binds claimer address; only matching `msg_sender` can reconstruct the correct FeeJuice nullifier |
| Bridge proof     | Kernel circuit verifies FeeJuice nullifier read request against nullifier tree (private, no public call)  |
| FPC double-spend | FPC-scoped nullifier; second `mint` fails                                                                 |
| Amount integrity | Mismatch in `amount` produces wrong nullifier — existence check fails                                     |
| Full privacy     | All inputs private; no public functions; class not published                                              |

### Deployment

No traditional deployment required. The `PrivateFPC` contract has no public functions, so its class does not need to be published to the class registry. The FPC address is computed deterministically from its class hash and initialization hash. Users interact with it privately by address.

The canonical deployment parameters (salt + expected address for the pinned Aztec version) live in `canonical-deployment.json`, which ships as an importable package subpath (`@alejoamiras/aztec-fee-payment/canonical-deployment.json`). `registerPrivateContract(wallet, salt, { assertCanonical: true })` verifies the provided salt and the derived address against that record BEFORE registering, throwing (fail closed) on any mismatch so a wrong salt/address never mutates PXE state — funds bridged to a stale/non-canonical address are unrecoverable. The check is opt-in (default off); operators using their own non-canonical salt simply omit it.

The FPC's public FeeJuice balance (used to pay sequencers) is funded separately via `FeeJuicePortal.depositToAztecPublic` targeting the FPC address directly, followed by `FeeJuice.claim` — the same flow used by the Metered FPC.

---

## Test Coverage Matrix

### Integration Tests (TypeScript/vitest)

| Test Case                                       | Method                  | Expected Result                                                                                                                    | Status  |
| ----------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `mint SUCCESS → pay_fee`                        | `mint()` + `pay_fee()`  | Bridge claim credited as FJ; subsequent sponsored tx succeeds; FPC FJ balance decreases; user FJ balance decreases by max gas cost | Planned |
| `mint double-spend REVERT`                      | `mint()` (second call)  | Second call reverts — FPC-scoped nullifier already exists                                                                          | Planned |
| `mint wrong claimer REVERT`                     | `mint()` (wrong sender) | Reverts — reconstructed FeeJuice nullifier doesn't exist in tree                                                                   | Planned |
| `mint_and_pay_fee SUCCESS`                      | `mint_and_pay_fee()`    | Bridge claim credited as FJ minus max gas cost; FPC sponsors the tx; user FJ balance = `amount - max_gas_cost`                     | Planned |
| `mint_and_pay_fee amount < max_gas_cost REVERT` | `mint_and_pay_fee()`    | Reverts with "Amount too low to cover gas cost" when `amount < max_gas_cost`                                                       | Planned |
| `mint_and_pay_fee amount == max_gas_cost`       | `mint_and_pay_fee()`    | Succeeds; user receives zero FJ credit (all consumed as fee)                                                                       | Planned |

### Balance Invariants

| Invariant                       | Assertion                                                          |
| ------------------------------- | ------------------------------------------------------------------ |
| Post-`mint` balance             | `user.fj_balance == old_balance + amount`                          |
| Post-`pay_fee` balance          | `user.fj_balance == old_balance - max_gas_cost`                    |
| Post-`mint_and_pay_fee` balance | `user.fj_balance == old_balance + amount - max_gas_cost`           |
| FPC FJ after `pay_fee`          | `fpc.fj_balance < fpc.fj_balance_before` (decreased by actual fee) |

### Test Infrastructure

- Tests require Aztec sandbox running locally (`aztec start --local-network`)
- Test timeout: 200 seconds
- Tests run sequentially (no parallelism) due to shared sandbox state
- No `warpL1Time` needed — no owner delay (`DelayedPublicMutable` not used)
- Stock upstream `SimpleToken` (from `@aztec/noir-contracts.js`, a devDependency) used as the application contract for testing fee sponsorship — the FPC sponsors a `mint_privately` on it. It replaced the previously-bundled local `counter_contract`; a stock contract needs no maintained Noir crate and never ships to consumers.
- FPC's public FeeJuice balance funded via `fundL2AddressWithFeeJuiceFromL1()`
- User's internal FJ balance funded via `bridgeForMint()` + `FeeJuice.claim` + `mint`
- Sponsored application transactions (tests and benchmarks) build `fee.gasSettings` with `estimateGasSettings()` before `send`, matching the SDK flow above

---

## Version History

| Version | Date       | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | March 2026 | Initial document — Private FPC with `mint_private`, no owner, no refund flow, fully private contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 1.0.1   | March 2026 | Changed `mint_private` note delivery from `ONCHAIN_CONSTRAINED` to `ONCHAIN_UNCONSTRAINED` for consistency with all other mint paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 1.1     | March 2026 | Renamed `mint_private` → `mint` and `mint_private_and_pay_fee` → `mint_and_pay_fee` for consistency with MeteredFPC API; added assertion `amount >= max_gas_cost` in `mint_and_pay_fee`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 1.2     | March 2026 | Documented `mint_and_pay_fee` across all PRD sections: added BR-7 requirement, Noir contract method row, contract interface pseudocode entry, test coverage cases, and `PrivateMintAndPayFeePaymentMethod` TypeScript class                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 1.2.1   | March 2026 | Corrected domain separator: `0xFEEDF00D` → `poseidon2_hash_bytes("az_dom_sep__fpc_bridge_secret")` = `3952304070` / `0xEB935FC6`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 1.3     | 2026-03-04 | (1) **Teardown double-counting fix**: `get_max_gas_cost` formula corrected — teardown gas limits removed. New formula: `da_gas_limit * max_fee_per_da_gas + l2_gas_limit * max_fee_per_l2_gas`. (2) **Shared `fpc_lib`**: `get_max_gas_cost` is now imported from the shared `fpc_lib` Nargo library (same package used by MeteredFPC); documented in new "Shared Library" section. (3) **SDK**: `FPCFeePaymentMethod` replaces `MeteredFeePaymentMethod` as the primary FPC-agnostic payment method class (works with PrivateFPC and MeteredFPC).                                                                                                  |
| 1.3.1   | 2026-03-24 | Updated Target Aztec Version from `4.0.0-devnet.2-patch.1` to `4.1.0-rc.4` to match package dependencies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 1.3.2   | 2026-03-30 | Updated Target Aztec Version from `4.1.0-rc.4` to `4.2.0-aztecnr-rc.2` to match package dependencies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 1.4     | 2026-04-01 | **SDK gas for sponsored txs**: Added `estimateGasSettings()` — simulate with `includeMetadata: true` and default gas padding to derive final `gasLimits` / `teardownGasLimits`; cap fees with `aztecNode.getCurrentMinFees()` scaled by `1.2×` (exact `6/5`, ceiling); set `maxPriorityFeesPerGas` equal to `maxFeesPerGas`. Tests/benchmarks use this helper when sending sponsored `Counter` txs.                                                                                                                                                                                                                                                 |
| 1.4.1   | 2026-05-15 | Updated Target Aztec Version from `4.2.0-aztecnr-rc.2` to `4.3.0-rc.1` to match package dependencies. Mechanical SDK migration in `registerPrivateContract` to the new `DeployMethod` API (address-affecting params — `salt`, `universalDeploy` — moved into the construction-time `instantiation` argument; `register()` no longer accepts options). `universalDeploy: true` replaces the prior `deployer: AztecAddress.ZERO` — same deterministic address, no behavior change. Test-only helper `warpL1Time` updated for the `EthCheatCodes.timestamp()` → `lastBlockTimestamp()` rename. No spec-level / public-API / security-property changes. |
| 1.4.2   | 2026-05-20 | Updated Target Aztec Version from `4.3.0-rc.1` to `4.3.0` (final release) to match package dependencies. No code or spec changes — version bump only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 1.5     | 2026-06-15 | Upgrade to Aztec 5.0.0-rc.1: MessageDelivery API + gas-estimation API adaptation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 1.5.1   | 2026-06-25 | **SDK input hardening**: `estimateGasSettings` now validates `estimatedGasPadding` up front — throws if it is not a non-negative finite number (rejects `NaN`/`Infinity`/negative; `0` allowed), failing fast before the simulation round-trip. Mirrors the existing `maxFeeMultiplier` (`normalizeMultiplier`) validation. Happy-path behavior unchanged for valid inputs.                                                                                                                                                                                                                                                                            |
| 1.5.2   | 2026-07-13 | Aztec `5.0.0` (stable) migration: `compute_secret_hash` / `compute_l1_to_l2_message_nullifier` now take the secret as `[Field; N]` — contract wraps its single-field bridge secret as `[secret]` (N=1 hashes are unchanged upstream, so all previously derived hashes/addresses are preserved). All PRD formula sites updated to the array form. Target Aztec Version bumped `5.0.0-rc.2` → `5.0.0`. No spec-level / public-API / security-property changes. |
| 1.5.3   | 2026-07-16 | Updated Target Aztec Version from `5.0.0` to `5.0.1` (upstream patch). No package-local API changes: `set_as_fee_payer()` already runs pre-`end_setup()` (satisfies the new non-revertible-phase assert, #24479); no note-history validation helpers in use (#24644). Canonical deployment parameters regenerated for the 5.0.1 artifact. |
| 1.6     | 2026-07-17 | **SDK security hardening** (features → minor bump; deferred audit findings `audit/security/2026-07-16-shd501`, no release — rides the next version bump): F-001 — optional `maxAcceptableGasCost` ceiling on `estimateGasSettings` (client-side cap independent of the node, since the FPC deducts the full max with no refund) + a one-time warn when omitted; F-002 — opt-in `assertCanonical` on `registerPrivateContract` (fail-closed salt/address check before registering) + `canonical-deployment.json` exported as a package subpath. Packaging: deleted the unused `artifactRegistry` module (F-003) and stopped shipping the test-only `counter_contract` artifact/binding (F-004). No contract (`.nr`) changes; no default-behavior changes for existing callers. |
| 1.7     | 2026-07-17 | **Test/benchmark vehicle swap** (test-only, no release): removed the local `counter_contract` Noir crate entirely and replaced it with the stock upstream `@aztec/noir-contracts.js` `SimpleToken` as the sponsored application (`mint_privately`) in the integration test and benchmark. Removes a hand-maintained Noir crate; the stock contract is a devDependency and never built into `target/` or shipped. Benchmark method entries renamed `increment*` → `simple_token_mint_privately[_fpc[_mint_and_pay_fee]]` (baseline numbers reset — a token op is heavier than a counter tick); standalone `mint_private` unchanged. PrivateFPC canonical address unchanged (no `.nr` change). No spec-level / public-API / security-property changes. |
