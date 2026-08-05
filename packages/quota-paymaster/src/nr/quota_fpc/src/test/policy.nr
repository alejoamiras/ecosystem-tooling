// =============================================================================
// Policy machinery through the REAL entrypoints: constructor bootstrap order,
// bundle sanity on both write paths, admin gate, CAS, the 12h delay, and
// pending-change replacement. Timestamp control per aztec-nr v5.0.1 TXE
// (forward-only: set_next_block_timestamp / advance_next_block_timestamp_by).
// =============================================================================

use crate::QuotaFpc;
use aztec::{
    protocol::{address::AztecAddress, traits::{Deserialize, Serialize}},
    test::helpers::test_environment::TestEnvironment,
};

use super::utils::{
    make_bundle, setup, test_classes, TEST_MAX_FEE, TEST_MAX_USERS, TEST_MAX_USES, test_targets,
};

global UPDATE_DELAY_SECONDS: u64 = 43200;

unconstrained fn read_policy(env: TestEnvironment, fpc: AztecAddress) -> [Field; 3] {
    let policy = env.execute_utility(QuotaFpc::at(fpc).get_policy());
    policy.serialize()
}

#[test]
unconstrained fn bootstrap_policy_is_live_immediately() {
    // THE bootstrap-order invariant (handoff pitfall #2): the constructor
    // writes the bundle at delay 0 and only then raises the delay, so the
    // policy must be in force in the very next block — an all-zero read here
    // means the write-then-raise order regressed and every fresh deploy
    // silently sponsors nothing for 12 hours.
    let (env, fpc, _admin) = setup();
    let got = read_policy(env, fpc);
    assert_eq(got[0], TEST_MAX_FEE as Field);
    assert_eq(got[1], TEST_MAX_USES as Field);
    assert_eq(got[2], TEST_MAX_USERS as Field);
}

#[test]
unconstrained fn allowed_targets_and_classes_are_live_immediately() {
    let (env, fpc, _admin) = setup();
    let targets = env.execute_utility(QuotaFpc::at(fpc).get_allowed_targets());
    assert_eq(targets[0], test_targets()[0]);
    assert_eq(targets[1], test_targets()[1]);
    let classes = env.execute_utility(QuotaFpc::at(fpc).get_allowed_account_classes());
    assert_eq(classes[0], test_classes()[0]);
}

#[test(should_fail_with = "admin must not be the zero address")]
unconstrained fn constructor_rejects_zero_admin() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let initializer = QuotaFpc::interface().constructor(
        AztecAddress::zero(),
        TEST_MAX_FEE,
        TEST_MAX_USES,
        TEST_MAX_USERS,
        test_targets(),
        test_classes(),
        true,
    );
    let _ = env.deploy("QuotaFpc").with_public_initializer(deployer, initializer);
}

#[test(should_fail_with = "at least one allowed account class is required")]
unconstrained fn constructor_rejects_empty_class_allowlist() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let initializer = QuotaFpc::interface().constructor(
        admin,
        TEST_MAX_FEE,
        TEST_MAX_USES,
        TEST_MAX_USERS,
        test_targets(),
        [0; 4],
        true,
    );
    let _ = env.deploy("QuotaFpc").with_public_initializer(admin, initializer);
}

#[test(should_fail_with = "at least one allowed target is required")]
unconstrained fn constructor_rejects_empty_target_allowlist() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let initializer = QuotaFpc::interface().constructor(
        admin,
        TEST_MAX_FEE,
        TEST_MAX_USES,
        TEST_MAX_USERS,
        [AztecAddress::zero(); 12],
        test_classes(),
        true,
    );
    let _ = env.deploy("QuotaFpc").with_public_initializer(admin, initializer);
}

#[test(should_fail_with = "caller is not admin")]
unconstrained fn schedule_rejects_non_admin() {
    let (mut env, fpc, _admin) = setup();
    let mallory = env.create_light_account();
    let bundle = make_bundle(TEST_MAX_FEE, TEST_MAX_USES, TEST_MAX_USERS, test_targets());
    env.call_public(mallory, QuotaFpc::at(fpc).schedule_settings(bundle, 0));
}

#[test(should_fail_with = "settings changed since you last read them")]
unconstrained fn schedule_rejects_stale_revision() {
    let (mut env, fpc, admin) = setup();
    let bundle = make_bundle(TEST_MAX_FEE, TEST_MAX_USES, TEST_MAX_USERS, test_targets());
    env.call_public(admin, QuotaFpc::at(fpc).schedule_settings(bundle, 7));
}

#[test(should_fail_with = "max_fee must be greater than zero")]
unconstrained fn schedule_rejects_insane_bundle() {
    // The constructor's invariants must hold on the update path too — the
    // reference contract once lost exactly these guards on its setter.
    let (mut env, fpc, admin) = setup();
    let bundle = make_bundle(0, TEST_MAX_USES, TEST_MAX_USERS, test_targets());
    env.call_public(admin, QuotaFpc::at(fpc).schedule_settings(bundle, 0));
}

#[test]
unconstrained fn schedule_takes_effect_only_after_the_delay() {
    let (mut env, fpc, admin) = setup();
    let bundle = make_bundle(
        TEST_MAX_FEE * 2,
        TEST_MAX_USES + 5,
        TEST_MAX_USERS,
        test_targets(),
    );
    env.call_public(admin, QuotaFpc::at(fpc).schedule_settings(bundle, 0));

    // Not yet: the old policy stays in force for the full 12h window.
    let before = read_policy(env, fpc);
    assert_eq(before[0], TEST_MAX_FEE as Field);
    assert_eq(before[1], TEST_MAX_USES as Field);

    // Forward past the delay (TXE time is forward-only) and mine so a block
    // exists at the new timestamp.
    env.advance_next_block_timestamp_by(UPDATE_DELAY_SECONDS + 1);
    env.mine_block();

    let after = read_policy(env, fpc);
    assert_eq(after[0], (TEST_MAX_FEE * 2) as Field);
    assert_eq(after[1], (TEST_MAX_USES + 5) as Field);
}

#[test]
unconstrained fn second_schedule_replaces_the_pending_first() {
    let (mut env, fpc, admin) = setup();
    let first = make_bundle(
        TEST_MAX_FEE * 2,
        TEST_MAX_USES,
        TEST_MAX_USERS,
        test_targets(),
    );
    env.call_public(admin, QuotaFpc::at(fpc).schedule_settings(first, 0));
    // There is ONE pending slot: the CAS revision moved to 1, and this second
    // schedule REPLACES the first rather than queueing behind it.
    let second = make_bundle(
        TEST_MAX_FEE * 3,
        TEST_MAX_USES + 9,
        TEST_MAX_USERS,
        test_targets(),
    );
    env.call_public(admin, QuotaFpc::at(fpc).schedule_settings(second, 1));

    env.advance_next_block_timestamp_by(UPDATE_DELAY_SECONDS + 1);
    env.mine_block();

    let after = read_policy(env, fpc);
    assert_eq(after[0], (TEST_MAX_FEE * 3) as Field);
    assert_eq(after[1], (TEST_MAX_USES + 9) as Field);
}

#[test]
unconstrained fn revision_counter_is_monotonic() {
    let (mut env, fpc, admin) = setup();
    let bundle = make_bundle(TEST_MAX_FEE, TEST_MAX_USES, TEST_MAX_USERS, test_targets());
    env.call_public(admin, QuotaFpc::at(fpc).schedule_settings(bundle, 0));
    let (_pending, _ts, revision) =
        env.call_public(admin, QuotaFpc::at(fpc).get_scheduled_settings());
    assert_eq(revision, 1);
}
