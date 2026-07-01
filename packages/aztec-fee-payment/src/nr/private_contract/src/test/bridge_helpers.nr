// derive_bridge_secret(salt, claimer) -> Field
// get_bridge_gas_msg_hash(fpc_address, amount) -> Field
// compute_feejuice_claim_nullifier(fpc_address, amount, salt, claimer, leaf_index, chain_id, version) -> Field
//
// Pure computation helpers. No oracle calls -- all tests runnable in TXE.

use crate::{PrivateFPC, test::utils};
use aztec::oracle::random::random;

// ---- derive_bridge_secret ----

/// Same inputs always produce the same secret (deterministic).
#[test]
unconstrained fn derive_bridge_secret_is_deterministic() {
    let (_, _, user, _) = utils::setup();
    let salt = random();

    let secret_a = PrivateFPC::derive_bridge_secret(salt, user);
    let secret_b = PrivateFPC::derive_bridge_secret(salt, user);

    assert(secret_a == secret_b, "Same inputs must yield same secret");
}

/// Different salts produce different secrets.
#[test]
unconstrained fn derive_bridge_secret_differs_by_salt() {
    let (_, _, user, _) = utils::setup();
    let salt_a = random();
    let salt_b = random();

    let secret_a = PrivateFPC::derive_bridge_secret(salt_a, user);
    let secret_b = PrivateFPC::derive_bridge_secret(salt_b, user);

    assert(secret_a != secret_b, "Different salts must yield different secrets");
}

/// Different claimers produce different secrets for the same salt.
#[test]
unconstrained fn derive_bridge_secret_differs_by_claimer() {
    let (_, _, user, other) = utils::setup();
    let salt = random();

    let secret_user = PrivateFPC::derive_bridge_secret(salt, user);
    let secret_other = PrivateFPC::derive_bridge_secret(salt, other);

    assert(secret_user != secret_other, "Different claimers must yield different secrets");
}

// ---- get_bridge_gas_msg_hash ----

/// Same inputs always produce the same content hash (deterministic).
#[test]
unconstrained fn get_bridge_gas_msg_hash_is_deterministic() {
    let (_, contract_address, _, _) = utils::setup();
    let amount: u128 = 1_000_000;

    let hash_a = PrivateFPC::get_bridge_gas_msg_hash(contract_address, amount);
    let hash_b = PrivateFPC::get_bridge_gas_msg_hash(contract_address, amount);

    assert(hash_a == hash_b, "Same inputs must yield same content hash");
}

/// Different amounts produce different content hashes.
#[test]
unconstrained fn get_bridge_gas_msg_hash_differs_by_amount() {
    let (_, contract_address, _, _) = utils::setup();

    let hash_a = PrivateFPC::get_bridge_gas_msg_hash(contract_address, 1_000_000);
    let hash_b = PrivateFPC::get_bridge_gas_msg_hash(contract_address, 2_000_000);

    assert(hash_a != hash_b, "Different amounts must yield different hashes");
}

/// Different FPC addresses produce different content hashes.
#[test]
unconstrained fn get_bridge_gas_msg_hash_differs_by_fpc_address() {
    let (_, contract_address, other, _) = utils::setup();
    let amount: u128 = 1_000_000;

    let hash_fpc = PrivateFPC::get_bridge_gas_msg_hash(contract_address, amount);
    let hash_other = PrivateFPC::get_bridge_gas_msg_hash(other, amount);

    assert(hash_fpc != hash_other, "Different FPC addresses must yield different hashes");
}

// ---- compute_feejuice_claim_nullifier ----

/// Same inputs produce the same nullifier (deterministic).
#[test]
unconstrained fn compute_feejuice_claim_nullifier_is_deterministic() {
    let (env, contract_address, user, _) = utils::setup();
    let salt = random();
    let leaf_index: Field = 42;
    let amount: u128 = 1_000_000;
    let (chain_id, version) =
        env.utility_context(|context| (context.chain_id(), context.version()));

    let nullifier_a = PrivateFPC::compute_feejuice_claim_nullifier(
        contract_address,
        amount,
        salt,
        user,
        leaf_index,
        chain_id,
        version,
    );
    let nullifier_b = PrivateFPC::compute_feejuice_claim_nullifier(
        contract_address,
        amount,
        salt,
        user,
        leaf_index,
        chain_id,
        version,
    );

    assert(nullifier_a == nullifier_b, "Same inputs must yield same nullifier");
}

/// Different claimers produce different nullifiers -- only the claimer can claim.
#[test]
unconstrained fn compute_feejuice_claim_nullifier_differs_by_claimer() {
    let (env, contract_address, user, other) = utils::setup();
    let salt = random();
    let leaf_index: Field = 42;
    let amount: u128 = 1_000_000;
    let (chain_id, version) =
        env.utility_context(|context| (context.chain_id(), context.version()));

    let nullifier_user = PrivateFPC::compute_feejuice_claim_nullifier(
        contract_address,
        amount,
        salt,
        user,
        leaf_index,
        chain_id,
        version,
    );
    let nullifier_other = PrivateFPC::compute_feejuice_claim_nullifier(
        contract_address,
        amount,
        salt,
        other,
        leaf_index,
        chain_id,
        version,
    );

    assert(nullifier_user != nullifier_other, "Different claimers must yield different nullifiers");
}

/// Different salts produce different nullifiers.
#[test]
unconstrained fn compute_feejuice_claim_nullifier_differs_by_salt() {
    let (env, contract_address, user, _) = utils::setup();
    let salt_a = random();
    let salt_b = random();
    let leaf_index: Field = 42;
    let amount: u128 = 1_000_000;
    let (chain_id, version) =
        env.utility_context(|context| (context.chain_id(), context.version()));

    let nullifier_a = PrivateFPC::compute_feejuice_claim_nullifier(
        contract_address,
        amount,
        salt_a,
        user,
        leaf_index,
        chain_id,
        version,
    );
    let nullifier_b = PrivateFPC::compute_feejuice_claim_nullifier(
        contract_address,
        amount,
        salt_b,
        user,
        leaf_index,
        chain_id,
        version,
    );

    assert(nullifier_a != nullifier_b, "Different salts must yield different nullifiers");
}

/// Different amounts produce different nullifiers -- amount mismatch cannot steal credit.
#[test]
unconstrained fn compute_feejuice_claim_nullifier_differs_by_amount() {
    let (env, contract_address, user, _) = utils::setup();
    let salt = random();
    let leaf_index: Field = 42;
    let (chain_id, version) =
        env.utility_context(|context| (context.chain_id(), context.version()));

    let nullifier_a = PrivateFPC::compute_feejuice_claim_nullifier(
        contract_address,
        1_000_000,
        salt,
        user,
        leaf_index,
        chain_id,
        version,
    );
    let nullifier_b = PrivateFPC::compute_feejuice_claim_nullifier(
        contract_address,
        2_000_000,
        salt,
        user,
        leaf_index,
        chain_id,
        version,
    );

    assert(nullifier_a != nullifier_b, "Different amounts must yield different nullifiers");
}

/// Different leaf indices produce different nullifiers.
#[test]
unconstrained fn compute_feejuice_claim_nullifier_differs_by_leaf_index() {
    let (env, contract_address, user, _) = utils::setup();
    let salt = random();
    let amount: u128 = 1_000_000;
    let (chain_id, version) =
        env.utility_context(|context| (context.chain_id(), context.version()));

    let nullifier_a = PrivateFPC::compute_feejuice_claim_nullifier(
        contract_address,
        amount,
        salt,
        user,
        42,
        chain_id,
        version,
    );
    let nullifier_b = PrivateFPC::compute_feejuice_claim_nullifier(
        contract_address,
        amount,
        salt,
        user,
        99,
        chain_id,
        version,
    );

    assert(nullifier_a != nullifier_b, "Different leaf indices must yield different nullifiers");
}
