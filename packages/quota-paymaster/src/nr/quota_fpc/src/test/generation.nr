// =============================================================================
// Generation freshness: UTC-day arithmetic + the rollover grace window
// (handoff §6 gap — ROLLOVER_GRACE_SECONDS previously had zero contract
// coverage). assert_generation_fresh is the contract's sole authority on which
// generation may be sponsored; these tests pin its behavior at day boundaries.
// Day D spans [D*86400, (D+1)*86400); the grace window is the final 600s.
// =============================================================================

use crate::QuotaFpc::assert_generation_fresh;

global DAY: u64 = 86400;
global GRACE: u64 = 600;
global D: u64 = 20666; // arbitrary test day (2026-08-05-ish)

#[test]
unconstrained fn today_is_sponsorable_all_day() {
    assert_generation_fresh(D * DAY, D as u32); // first second of the day
    assert_generation_fresh(D * DAY + DAY / 2, D as u32); // midday
    assert_generation_fresh(D * DAY + DAY - 1, D as u32); // last second
}

#[test(should_fail_with = "Generation is not currently sponsorable")]
unconstrained fn yesterday_is_rejected() {
    assert_generation_fresh(D * DAY + DAY / 2, (D - 1) as u32);
}

#[test(should_fail_with = "Generation is not currently sponsorable")]
unconstrained fn tomorrow_is_rejected_at_midday() {
    assert_generation_fresh(D * DAY + DAY / 2, (D + 1) as u32);
}

#[test]
unconstrained fn tomorrow_is_sponsorable_inside_grace_window() {
    // Grace opens at exactly DAY - GRACE seconds into the day (>= comparison).
    assert_generation_fresh(D * DAY + (DAY - GRACE), (D + 1) as u32);
    assert_generation_fresh(D * DAY + DAY - 1, (D + 1) as u32);
}

#[test(should_fail_with = "Generation is not currently sponsorable")]
unconstrained fn tomorrow_is_rejected_one_second_before_grace() {
    assert_generation_fresh(D * DAY + (DAY - GRACE - 1), (D + 1) as u32);
}

#[test(should_fail_with = "Generation is not currently sponsorable")]
unconstrained fn day_after_tomorrow_is_rejected_even_in_grace() {
    assert_generation_fresh(D * DAY + DAY - 1, (D + 2) as u32);
}

#[test]
unconstrained fn midnight_crossing_flips_the_valid_generation() {
    // One second before midnight: D valid, D+1 valid (grace).
    assert_generation_fresh(D * DAY + DAY - 1, D as u32);
    assert_generation_fresh(D * DAY + DAY - 1, (D + 1) as u32);
    // First second after midnight: D+1 valid…
    assert_generation_fresh((D + 1) * DAY, (D + 1) as u32);
}

#[test(should_fail_with = "Generation is not currently sponsorable")]
unconstrained fn yesterdays_generation_dies_at_midnight() {
    // …and D is no longer sponsorable the moment the day rolls.
    assert_generation_fresh((D + 1) * DAY, D as u32);
}
