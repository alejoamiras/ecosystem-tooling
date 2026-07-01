use aztec::macros::aztec;
pub mod test;

/// Private Fee Payment Contract
///
/// Fully private FPC (no public functions, no owner, no off-chain agent).
/// Users bridge FeeJuice from L1 via FeeJuicePortal to this contract address,
/// then call `mint` to convert the bridge claim into private FJ balance.
/// The FJ balance can then be used to sponsor transactions via `pay_fee`.
#[aztec]
pub contract PrivateFPC {
    use aztec::{
        hash::{
            compute_l1_to_l2_message_hash, compute_l1_to_l2_message_nullifier, compute_secret_hash,
        },
        macros::{functions::{allow_phase_change, external, internal, only_self}, storage::storage},
        messages::delivery::MessageDelivery,
        nullifier::utils::compute_nullifier_existence_request,
        protocol::{
            address::{AztecAddress, EthAddress},
            constants::FEE_JUICE_ADDRESS,
            hash::{poseidon2_hash_with_separator, sha256_to_field},
            traits::ToField,
        },
        state_vars::Owned,
    };
    use balance_set::BalanceSet;
    use fpc_lib::get_max_gas_cost;

    // gas-optimized max notes for initial transfer call
    global INITIAL_TRANSFER_CALL_MAX_NOTES: u32 = 2;
    // max notes for recursive transfer call if initial max notes are exceeded
    global RECURSIVE_TRANSFER_CALL_MAX_NOTES: u32 = 8;

    /// Domain separator for bridge secret derivation.
    /// Avoids collisions with other poseidon2 usages.
    /// Value: poseidon2_hash_bytes("az_dom_sep__fpc_bridge_secret") as u32
    global DOM_SEP__FPC_BRIDGE_SECRET: u32 = 3952304070;

    /// @param balances The private note-based balances mapping accounts to their internal FPC balance
    #[storage]
    struct Storage<Context> {
        balances: Owned<BalanceSet<Context>, Context>,
    }

    /// @notice Sponsors the transaction by deducting max gas cost from sender's balance.
    /// @dev Does not refund unused gas - the full max_gas_cost is consumed.
    #[external("private")]
    #[allow_phase_change]
    fn pay_fee() {
        let sender = self.msg_sender();
        let _max_gas_cost = self.internal._deduct_max_gas_cost(sender);

        // Set the FPC as the fee payer of the tx.
        self.context.set_as_fee_payer();
        // End the setup phase.
        self.context.end_setup();
    }

    /// @notice Mints internal FJ balance and pays fee in one transaction (cold-start flow).
    ///
    /// Combines the bridge claim proof with fee payment: proves the L1->L2 bridge claim,
    /// credits (amount - max_gas_cost) to the claimer, and sets the FPC as fee payer.
    ///
    /// Prerequisites (must execute in the same tx, before this call):
    ///   - FeeJuice.claim(this_fpc_address, amount, secret, leaf_index) emits the FeeJuice
    ///     nullifier that this function asserts via assert_nullifier_exists.
    ///
    /// Security: same as mint -- only the claimer can reconstruct the correct FeeJuice
    /// nullifier; FPC-scoped nullifier prevents double-spending.
    ///
    /// @param amount     The exact amount bridged (must match the L1 deposit exactly).
    /// @param salt       The random value chosen by the claimer at deposit time.
    /// @param leaf_index The L1 message leaf index from the deposit transaction.
    #[external("private")]
    #[allow_phase_change]
    fn mint_and_pay_fee(amount: u128, salt: Field, leaf_index: Field) {
        let claimer = self.msg_sender();

        let feejuice_nullifier = compute_feejuice_claim_nullifier(
            self.address,
            amount,
            salt,
            claimer,
            leaf_index,
            self.context.chain_id(),
            self.context.version(),
        );

        self.context.assert_nullifier_exists(compute_nullifier_existence_request(
            feejuice_nullifier,
            FEE_JUICE_ADDRESS,
        ));

        // FPC-scoped nullifier prevents double-spending this bridge credit.
        self.context.push_nullifier_unsafe(feejuice_nullifier);

        // Credit (amount - max_gas_cost) to claimer. The fee is implicitly deducted
        // since the full amount was bridged but only the remainder is credited.
        let max_gas_cost = get_max_gas_cost(self.context);
        assert(amount >= max_gas_cost, "Amount too low to cover gas cost");
        self.storage.balances.at(claimer).add(amount - max_gas_cost).deliver(
            MessageDelivery::onchain_unconstrained(),
        );

        self.context.set_as_fee_payer();
        self.context.end_setup();
    }

    /// @notice Mints internal FJ balance by proving a prior L1->L2 FeeJuice bridge claim.
    ///
    /// Prerequisites (must happen before or in the same tx as this call):
    ///   1. On L1: FeeJuicePortal.depositToAztecPublic(
    ///        _to        = this_fpc_address,
    ///        _amount    = amount,
    ///        _secretHash = compute_secret_hash(derive_bridge_secret(salt, claimer_aztec_address))
    ///      )
    ///   2. On L2: FeeJuice.claim(
    ///        to                 = this_fpc_address,
    ///        amount             = amount,
    ///        secret             = derive_bridge_secret(salt, claimer_aztec_address),
    ///        message_leaf_index = leaf_index
    ///      )  ->  FJ credited to FPC's public FeeJuice balance; FeeJuice nullifier emitted.
    ///
    /// Security:
    ///   - Auth: only msg_sender == claimer can reconstruct the correct FeeJuice nullifier.
    ///   - Bridge proof: kernel verifies FeeJuice nullifier exists (pending or settled).
    ///   - Double-spend: FPC emits its own nullifier (siloed under FPC address), distinct from
    ///     the FeeJuice-siloed one - preventing the same bridge from being minted twice.
    ///
    /// @param amount     The exact amount bridged (must match the L1 deposit exactly).
    /// @param salt       A random value chosen by the claimer at deposit time.
    /// @param leaf_index The L1 message leaf index from the deposit transaction.
    #[external("private")]
    fn mint(amount: u128, salt: Field, leaf_index: Field) {
        let claimer = self.msg_sender();

        // Reconstruct the nullifier FeeJuice.claim emitted when consuming the bridge message.
        // Only the claimer can compute this correctly - derive_bridge_secret binds their address.
        let feejuice_nullifier = compute_feejuice_claim_nullifier(
            self.address,
            amount,
            salt,
            claimer,
            leaf_index,
            self.context.chain_id(),
            self.context.version(),
        );

        // Assert the FeeJuice nullifier exists entirely in private.
        // The kernel circuit verifies this read request against the nullifier tree - no public call needed.
        // compute_nullifier_existence_request handles pending (same-tx) vs settled nullifiers.
        self.context.assert_nullifier_exists(compute_nullifier_existence_request(
            feejuice_nullifier,
            FEE_JUICE_ADDRESS,
        ));

        // Emit an FPC-scoped nullifier to prevent double-minting this bridge credit.
        // Siloed as poseidon2([FPC_address, feejuice_nullifier]) - distinct from the
        // FeeJuice-siloed version poseidon2([FeeJuice_address, feejuice_nullifier]).
        self.context.push_nullifier_unsafe(feejuice_nullifier);

        // Mint private internal balance to claimer.
        self.storage.balances.at(claimer).add(amount).deliver(
            MessageDelivery::onchain_unconstrained(),
        );
    }

    /// @notice Computes the max gas cost and deducts it from the account's balance.
    /// @param account The address to deduct the gas cost from
    /// @return The max gas cost that was deducted
    #[internal("private")]
    fn _deduct_max_gas_cost(account: AztecAddress) -> u128 {
        let max_gas_cost = get_max_gas_cost(self.context);

        let change =
            self.internal._subtract_balance(account, max_gas_cost, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.storage.balances.at(account).add(change).deliver(
            MessageDelivery::onchain_unconstrained(),
        );

        max_gas_cost
    }

    /// @notice Subtracts balance from private balance.
    /// @dev Recurses via `recurse_subtract_balance_internal` if `max_notes` is insufficient.
    /// @param account   The address of the account to subtract the balance from
    /// @param amount    The amount of tokens to subtract
    /// @param max_notes The maximum number of notes to process in a single call
    /// @return The change to return to the owner
    #[internal("private")]
    fn _subtract_balance(account: AztecAddress, amount: u128, max_notes: u32) -> u128 {
        let subtracted = self.storage.balances.at(account).try_sub(amount, max_notes);
        if subtracted >= amount {
            subtracted - amount
        } else {
            assert(subtracted > 0, "Balance too low");

            let remaining = amount - subtracted;
            self.call_self.recurse_subtract_balance_internal(account, remaining)
        }
    }

    /// @notice Recursively subtracts balance from private balance.
    /// @param account The address of the account to subtract the balance from
    /// @param amount  The amount to subtract
    /// @return The change to return to the owner
    #[external("private")]
    #[only_self]
    fn recurse_subtract_balance_internal(account: AztecAddress, amount: u128) -> u128 {
        self.internal._subtract_balance(account, amount, RECURSIVE_TRANSFER_CALL_MAX_NOTES)
    }

    /// @notice Returns the private balance of an account
    /// @param account The address to query
    /// @return The private balance of the account
    #[external("utility")]
    unconstrained fn balance_of(account: AztecAddress) -> u128 {
        self.storage.balances.at(account).balance_of()
    }

    // --- Bridge mint helpers ---

    /// @notice Derives the bridge secret from (salt, claimer).
    ///
    /// Only the claimer can compute this, since it binds their Aztec address.
    /// The corresponding L1 secretHash must be:
    ///   compute_secret_hash(derive_bridge_secret(salt, claimer_aztec_address))
    ///
    /// @param salt    A random value chosen by the claimer at deposit time.
    /// @param claimer The Aztec address of the claimer.
    /// @return The bridge secret.
    #[contract_library_method]
    pub fn derive_bridge_secret(salt: Field, claimer: AztecAddress) -> Field {
        poseidon2_hash_with_separator([salt, claimer.to_field()], DOM_SEP__FPC_BRIDGE_SECRET)
    }

    /// @notice Computes the FeeJuice L1->L2 message content hash for bridging `amount` to `fpc_address`.
    ///
    /// Mirrors FeeJuicePortal.depositToAztecPublic on L1:
    ///   sha256(abi.encodeWithSignature("claim(bytes32,uint256)", fpc_address, amount))
    ///
    /// The 4-byte selector keccak256("claim(bytes32,uint256)")[0:4] is computed at compile-time only -
    /// zero runtime cost.
    ///
    /// @param fpc_address The FPC contract address (recipient of the bridge).
    /// @param amount      The amount of FeeJuice bridged.
    /// @return The content hash field element.
    #[contract_library_method]
    pub fn get_bridge_gas_msg_hash(fpc_address: AztecAddress, amount: u128) -> Field {
        let mut hash_bytes = [0 as u8; 68];
        let recipient_bytes: [u8; 32] = fpc_address.to_field().to_be_bytes();
        let amount_bytes: [u8; 32] = (amount as Field).to_be_bytes();

        // EVM ABI function selector: keccak256("claim(bytes32,uint256)")[0:4]
        // Must match exactly what FeeJuicePortal.depositToAztecPublic encodes on L1.
        // Evaluated at compile-time only - zero runtime cost.
        let selector: [u8; 32] =
            comptime { keccak256::keccak256("claim(bytes32,uint256)".as_bytes(), 22) };

        for i in 0..4 {
            hash_bytes[i] = selector[i];
        }
        for i in 0..32 {
            hash_bytes[i + 4] = recipient_bytes[i];
            hash_bytes[i + 36] = amount_bytes[i];
        }

        sha256_to_field(hash_bytes)
    }

    /// @notice Reconstructs the nullifier that FeeJuice.claim emits when consuming the bridge message.
    ///
    /// FeeJuice.claim calls consume_l1_to_l2_message which:
    ///   1. Derives secret_hash = compute_secret_hash(secret)
    ///   2. Computes message_hash = sha256(portal | chain_id | fee_juice_l2 | version | content | secret_hash | leaf_index)
    ///   3. Emits nullifier = poseidon2([message_hash, secret], DOM_SEP__MESSAGE_NULLIFIER)
    ///
    /// By reconstructing this, the FPC can verify FeeJuice.claim was already executed.
    ///
    /// Protocol invariant: FeeJuice portal Eth address == FEE_JUICE_ADDRESS as a Field.
    /// See FeeJuice.claim_helper: EthAddress::from_field(FEE_JUICE_ADDRESS.to_field())
    ///
    /// @param fpc_address The FPC contract address (recipient of the bridge).
    /// @param amount      The exact amount bridged.
    /// @param salt        A random value chosen by the claimer at deposit time.
    /// @param claimer     The Aztec address of the claimer.
    /// @param leaf_index  The L1 message leaf index.
    /// @param chain_id    The L1 chain ID.
    /// @param version     The Aztec protocol version.
    /// @return The FeeJuice claim nullifier.
    #[contract_library_method]
    pub fn compute_feejuice_claim_nullifier(
        fpc_address: AztecAddress,
        amount: u128,
        salt: Field,
        claimer: AztecAddress,
        leaf_index: Field,
        chain_id: Field,
        version: Field,
    ) -> Field {
        let secret = derive_bridge_secret(salt, claimer);
        let content_hash = get_bridge_gas_msg_hash(fpc_address, amount);
        let secret_hash = compute_secret_hash(secret);

        let fee_juice_portal = EthAddress::from_field(FEE_JUICE_ADDRESS.to_field());

        let message_hash = compute_l1_to_l2_message_hash(
            fee_juice_portal,
            chain_id,
            FEE_JUICE_ADDRESS,
            version,
            content_hash,
            secret_hash,
            leaf_index,
        );

        compute_l1_to_l2_message_nullifier(message_hash, secret)
    }

}
