# Cluster C2 — Noir bridge and cryptographic derivation

## Result

No security findings met the required concrete-trace threshold.

## Scope reviewed

- `packages/aztec-fee-payment/src/nr/private_contract/src/main.nr`: `DOM_SEP__FPC_BRIDGE_SECRET`, `derive_bridge_secret`, `get_bridge_gas_msg_hash`, and `compute_feejuice_claim_nullifier`.
- `packages/aztec-fee-payment/src/ts/test/harness.ts:111-118,165-167`: TypeScript domain-separator and bridge-secret mirror.
- Aztec 5.0.1 FeeJuice L1 portal, L2 `claim_helper`, message-hash/nullifier helpers, protocol constants, field serialization, and contract siloing.

## Security conclusions supporting the result

- **Domain separator parity:** evaluating `poseidon2HashBytes(Buffer.from("az_dom_sep__fpc_bridge_secret")) & 0xffffffff` with the installed Aztec 5.0.1 implementation yields `3952304070`, exactly matching `main.nr:38` and the TypeScript computation at `harness.ts:116-118`. Both Noir and TypeScript then call Poseidon2-with-separator over the ordered pair `[salt, claimer]` (`main.nr:233-236`, `harness.ts:165-167`). No reused production separator with an exploitable, type-compatible preimage path was found.
- **FeeJuice content parity:** the reviewed function constructs exactly 68 bytes: the first four bytes of `keccak256("claim(bytes32,uint256)")`, followed by the 32-byte big-endian FPC address field and 32-byte big-endian zero-extended `u128` amount (`main.nr:250-269`). The selector is `0x63f44968`. This is byte-identical to Aztec 5.0.1's L2 FeeJuice helper and to the L1 portal's `sha256ToField(abi.encodeWithSignature("claim(bytes32,uint256)", _to, _amount))`. The comptime literal has explicit length 22, which is the literal's exact byte length; compiler or signature drift fails closed by producing a non-matching content hash rather than accepting a forged message.
- **Message/nullifier parity:** `compute_feejuice_claim_nullifier` derives `secret_hash = Poseidon2([secret], DOM_SEP__SECRET_HASH)`, hashes the ordered 32-byte fields `portal | chain_id | FEE_JUICE_ADDRESS | version | content | secret_hash | leaf_index` with SHA-256-to-field, and derives `Poseidon2([message_hash, secret], DOM_SEP__MESSAGE_NULLIFIER)` (`main.nr:302-320`). These are the same Aztec 5.0.1 helpers invoked by FeeJuice's `consume_l1_to_l2_message`; the N=1 secret migration preserves the two-element nullifier preimage.
- **Claim and replay binding:** the message commits to FPC recipient, exact amount, secret hash, portal identity, L2 FeeJuice recipient, leaf index, L1 chain ID, and Aztec version (`main.nr:250-269`, `main.nr:302-320`). The secret additionally commits to `salt` and `msg_sender` (`main.nr:234-235`, `main.nr:297-303`). A claim from a different rollup/chain, bridge leaf, amount, FPC, or claimer therefore produces a different asserted nullifier. The absence of chain/version fields inside the inner secret is not exploitable because both are present in the outer message hash before nullifier derivation.
- **Field and packing safety:** all serialized components are fixed-width big-endian fields. `amount` is range-constrained as `u128` before casting to `Field`, so it is ABI-equivalent to a zero-extended `uint256` and cannot overflow the BN254 field. `AztecAddress` is already field-valued. SHA-256-to-field reduction is the same protocol primitive on L1 and L2; no alternate packing accepted by only one side was found.
- **Predictability and disclosure:** claimer addresses and domain separators are public, but a bridge secret remains dependent on the depositor-selected field `salt`. The private claim/mint arguments do not publish that salt or secret. Guessing a low-entropy salt could let an observer derive the FeeJuice consumption secret, but it still does not let a different `msg_sender` satisfy the FPC's claimer-bound derivation without a Poseidon2 collision. No production source-to-leak-to-theft trace was present in the audited files.
- **Reorg handling:** the contract proves a FeeJuice nullifier against Aztec's accepted nullifier state (or a same-transaction pending effect); it does not consume unauthenticated L1 event data directly. Canonical L1 ingestion/reorg handling is therefore outside this contract's trust decision, and no contract-local bypass trace was found.

## Finding count

**0**
