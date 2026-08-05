// =============================================================================
// QuotaFpc — TXE test utilities
//
// The contract is vendored byte-verbatim from the mainnet deployment (see
// known-deployments.json); tests observe it from the outside via its public /
// utility surface and via its contract-library methods.
// =============================================================================

use crate::QuotaFpc;
use aztec::{
    protocol::{address::AztecAddress, traits::{Deserialize, FromField, ToField}},
    test::helpers::test_environment::TestEnvironment,
};

pub global TEST_MAX_FEE: u128 = 1_000_000_000;
pub global TEST_MAX_USES: u32 = 5;
pub global TEST_MAX_USERS: u32 = 3;
pub global MAX_ALLOWED_TARGETS: u32 = 12;
pub global MAX_ALLOWED_ACCOUNT_CLASSES: u32 = 4;

pub unconstrained fn test_targets() -> [AztecAddress; MAX_ALLOWED_TARGETS] {
    let mut targets = [AztecAddress::zero(); MAX_ALLOWED_TARGETS];
    targets[0] = AztecAddress::from_field(0x1234);
    targets[1] = AztecAddress::from_field(0x5678);
    targets
}

pub unconstrained fn test_classes() -> [Field; MAX_ALLOWED_ACCOUNT_CLASSES] {
    let mut classes = [0; MAX_ALLOWED_ACCOUNT_CLASSES];
    classes[0] = 0xabc1;
    classes
}

/// PolicyBundle's fields are module-private; construct through its derived
/// Deserialize impl. Serialized order (= declaration order): max_fee, max_uses,
/// max_users, allowed_targets[12] — 15 fields.
pub unconstrained fn make_bundle(
    max_fee: u128,
    max_uses: u32,
    max_users: u32,
    targets: [AztecAddress; MAX_ALLOWED_TARGETS],
) -> QuotaFpc::PolicyBundle {
    let mut fields = [0; 15];
    fields[0] = max_fee as Field;
    fields[1] = max_uses as Field;
    fields[2] = max_users as Field;
    for i in 0..MAX_ALLOWED_TARGETS {
        fields[3 + i] = targets[i].to_field();
    }
    QuotaFpc::PolicyBundle::deserialize(fields)
}

/// Deploys QuotaFpc with the standard test configuration via its REAL public
/// constructor (exercising the bootstrap write-then-raise-delay ordering).
pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let initializer = QuotaFpc::interface().constructor(
        admin,
        TEST_MAX_FEE,
        TEST_MAX_USES,
        TEST_MAX_USERS,
        test_targets(),
        test_classes(),
        true,
    );
    let fpc = env.deploy("QuotaFpc").with_public_initializer(admin, initializer);
    (env, fpc, admin)
}
