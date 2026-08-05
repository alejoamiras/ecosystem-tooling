// Representative TXE test content for the Phase-1 class-id-neutrality spike
// (plan D2.2): proves that registering the test module leaves the compiled
// contract class id unchanged. Grows into the real suite in Phase 2.
use aztec::test::helpers::test_environment::TestEnvironment;

#[test]
unconstrained fn spike_environment_boots() {
    let mut env = TestEnvironment::new();
    let account = env.create_light_account();
    assert(!account.is_zero());
}
