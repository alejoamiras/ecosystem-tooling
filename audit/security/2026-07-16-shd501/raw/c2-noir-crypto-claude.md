# Cluster C2 — Noir bridge/crypto derivation (Claude)

Scope: `packages/aztec-fee-payment/src/nr/private_contract/src/main.nr`
(`derive_bridge_secret` :233-236, `DOM_SEP__FPC_BRIDGE_SECRET` :38,
`get_bridge_gas_msg_hash` :249-270, `compute_feejuice_claim_nullifier` :292-321,
`FEE_JUICE_ADDRESS` usage :281, comptime keccak block :258-259) cross-checked
against `src/ts/test/harness.ts:116-118,166` and the installed Aztec 5.0.1
protocol source (`~/nargo/.../aztec-packages/v5.0.1`, matches this repo's pinned
`config.aztecVersion: 5.0.1`).

## Result

**0 findings meet the concrete-exploit-path bar.** This cluster is the one place
in the package where I'd expect drift bugs, and it isn't there — the domain
separator was independently recomputed, the hand-copied L1 mirror function was
diffed byte-for-byte against the protocol's own copy, and the nullifier
reconstruction was traced through the real `consume_l1_to_l2_message` call path
rather than trusted from comments.

## Verification performed (not just read — recomputed / diffed / traced)

1. **Domain separator, recomputed independently.** Ran the actual
   `@aztec/foundation/crypto/sync` `poseidon2HashBytes` (v5.0.1, installed in
   this workspace's `node_modules`) against the literal string
   `"az_dom_sep__fpc_bridge_secret"`:
   ```
   full field: 0x2869cb7a53903a3dd77d0fdc8c46a72e627d29041ba240b17a2996c9eb935fc6
   low32:      3952304070   (== 0xEB935FC6)
   ```
   This matches `DOM_SEP__FPC_BRIDGE_SECRET: u32 = 3952304070` at `main.nr:38`,
   the TS mirror at `harness.ts:116-118` (`poseidon2HashBytes(...).toBigInt() &
   0xffff_ffffn`), and the PRD's documented v1.2.1 correction
   (`docs/private-product-requirements.md:289`, `0xFEEDF00D` →
   `0xEB935FC6`). Grepped the full protocol `constants.nr`
   (`noir-protocol-circuits/crates/types/src/constants.nr`, ~50 `DOM_SEP__*`
   entries) and the rest of this repo for `3952304070` — no collision with any
   protocol-reserved separator or any other app-level constant.

2. **`get_bridge_gas_msg_hash`, diffed against the protocol's own copy.** This
   function is a hand-duplicated (not imported) mirror of
   `fee_juice_contract/src/lib.nr::get_bridge_gas_msg_hash` in aztec-packages
   v5.0.1. Byte-for-byte comparison: identical 68-byte layout (4-byte selector +
   32-byte recipient + 32-byte amount), identical
   `comptime { keccak256::keccak256("claim(bytes32,uint256)".as_bytes(), 22) }`
   call (string length 22 matches the literal exactly — no silent truncation).
   Cross-checked against the actual L1 Solidity
   (`l1-contracts/src/core/messagebridge/FeeJuicePortal.sol:49`):
   `Hash.sha256ToField(abi.encodeWithSignature("claim(bytes32,uint256)", _to, _amount))`
   — same selector string, same `bytes32 | uint256` layout. `Hash.sol`'s
   truncation (`bytes32(bytes.concat(new bytes(1), bytes31(sha256(_data))))`,
   i.e. drop the last byte, prepend a zero byte) is the same truncation as
   Noir's `sha256_to_field` (`field_from_bytes_32_trunc`, verified against the
   `smoke_sha256_to_field` test in `hash.nr` which explicitly compares the
   "truncate one byte" vs "mod full bytes" variants). L1 and L2 content hashes
   are provably identical for any given `(to, amount)`.

3. **`compute_feejuice_claim_nullifier`, traced against the real consumption
   path, not reimplemented in isolation.** `main.nr:12-15` imports
   `compute_l1_to_l2_message_hash`, `compute_l1_to_l2_message_nullifier`, and
   `compute_secret_hash` directly from `aztec::hash` — these are **not**
   reimplemented by the FPC, eliminating drift risk for the two most complex
   primitives. Traced the real consumption side:
   `FeeJuice.claim` → `claim_helper` (`fee_juice_contract/src/main.nr:47-69`)
   → `context.consume_l1_to_l2_message(content_hash, secret, portal_address,
   leaf_index)` (`private_context.nr:890-910`) → `process_l1_to_l2_message`
   (`messaging.nr:8-45`), which computes `secret_hash = compute_secret_hash(secret)`,
   `message_hash = compute_l1_to_l2_message_hash(portal, chain_id,
   contract_address, version, content, secret_hash, leaf_index)`, and
   `nullifier = compute_l1_to_l2_message_nullifier(message_hash, secret)`.
   `compute_feejuice_claim_nullifier` (`main.nr:292-321`) constructs the
   identical argument tuple: `portal = EthAddress::from_field(FEE_JUICE_ADDRESS.to_field())`
   matches `claim_helper`'s own `let portal_address: EthAddress =
   EthAddress::from_field(FEE_JUICE_ADDRESS.to_field())` verbatim (same
   expression, so any oddity in that truncation affects both sides identically
   — no asymmetry possible); `contract_address = FEE_JUICE_ADDRESS` matches
   `claim_helper`'s `self.this_address()` (the FeeJuice contract's own address
   *is* `FEE_JUICE_ADDRESS` by protocol definition); `chain_id`/`version` are
   read live via `self.context.chain_id()` / `self.context.version()`, matching
   `process_l1_to_l2_message`'s use of the same context accessors. No parameter
   is drifted, reordered, or omitted.

4. **Claimer binding / anti-theft, traced control flow.** `derive_bridge_secret`
   folds `claimer.to_field()` into the Poseidon2 preimage. In `mint` /
   `mint_and_pay_fee`, `claimer := self.msg_sender()` (not a caller-supplied
   parameter) is fed into `compute_feejuice_claim_nullifier`. An attacker
   calling `mint(amount, salt, leaf_index)` from their own address recomputes
   `derive_bridge_secret(salt, attacker_address)`, which — absent a Poseidon2
   preimage collision — differs from the secret embedded in the real deposit's
   `secretHash`, so `content_hash`/`message_hash`/`feejuice_nullifier` all
   diverge and `assert_nullifier_exists` fails closed. This exact scenario is
   asserted by a real end-to-end test, not just claimed in comments:
   `src/ts/test/private.test.ts:169-200` ("mint wrong claimer REVERT: bob cannot
   claim alice's bridge deposit") drives the actual `FeeJuicePortal` L1 contract
   and `FeeJuice.claim` on a live local network, then asserts Bob's `mint` call
   rejects. `private.test.ts:132-165` similarly asserts double-mint reverts
   using the real FPC-scoped nullifier silo. Both tests run in mandatory CI
   (`.github/workflows/aztec-fee-payment.yml` → `_package-checks.yml`
   `js-tests` job, `start-local-network: true`, gates every PR by default) —
   these aren't opt-in / manual-only checks.

5. **Double-spend silo, checked against protocol nullifier semantics.**
   `push_nullifier_unsafe` (`private_context.nr:395-398`, doc comment
   confirms) never inserts the raw value into the tree — the kernel always
   siloes by the pushing contract's address via `compute_siloed_nullifier`.
   Since `mint` pushes `feejuice_nullifier` under the FPC's own address (via
   `self.context.push_nullifier_unsafe`) while `FeeJuice.claim` pushes the same
   raw value under `FEE_JUICE_ADDRESS`, the two siloed tree entries are
   necessarily distinct field elements. The FPC's copy is therefore a genuine,
   independent double-spend guard, not a duplicate of FeeJuice's own nullifier.

6. **Chain/version replay.** `chain_id` and `version` are both live context
   reads folded into `message_hash` before the nullifier is derived — a claim
   valid on one chain/version cannot satisfy `assert_nullifier_exists` on
   another, since the entire downstream hash chain differs.

7. **Byte-packing / overflow.** `amount: u128` cast to `Field` before
   `to_be_bytes::<32>()` — u128's range fits BN254's ~254-bit field with room
   to spare, so this is a lossless widening cast, not a truncating one.
   `AztecAddress.to_field()` is already field-valued by construction. No
   packing overflow in the 68-byte or 224-byte buffers.

## Explicitly considered and ruled out (no exploit path found)

- **Secret/salt leakage via public calldata**: `FeeJuice.claim` and the FPC's
  `mint`/`mint_and_pay_fee` are all `#[external("private")]` — arguments
  (including `salt`, `secret`) are folded into `args_hash` for the kernel and
  never published on-chain. No trace of `salt` or `secret` reaching a public
  function argument, event, or public storage slot in this package.
- **Cross-FPC nullifier reuse**: `get_bridge_gas_msg_hash` binds `self.address`
  (the specific FPC instance) into `content_hash`; a deposit made `_to` one FPC
  address cannot satisfy another FPC's nullifier reconstruction.
- **Grinding a low-entropy salt**: would let an observer who already knows the
  raw `secret` derive nothing further useful — they'd still need to be the
  address folded into `derive_bridge_secret`'s preimage to pass `mint`'s
  self-`msg_sender` rebinding. Not exploitable without a Poseidon2 preimage
  break.

## One structural observation (not a finding — no unmitigated exploit path)

`get_bridge_gas_msg_hash` is a hand-duplicated copy of the protocol's canonical
implementation (necessary — Noir can't import a sibling contract's
`#[contract_library_method]` across the protocol/app boundary here) with no
*static* parity check against the FeeJuice contract's own copy at each Aztec
version bump (`scripts/bump-aztec.ts` does not diff this function). If a future
Aztec version changed the L1 ABI encoding, this would fail **closed**
(`assert_nullifier_exists` never succeeds → permanent inability to mint bridged
funds on this FPC, not a theft or bypass). This is fully covered today by the
mandatory, non-optional `js-tests` CI job exercising the real bridge → claim →
mint path on every PR (see point 4 above), so I'm not raising it as a finding —
flagging only so a future version-bump reviewer knows this is the test that
would catch drift, not the (nonexistent) static check.

## Finding count

**0**
