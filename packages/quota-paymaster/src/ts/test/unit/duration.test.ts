/**
 * Duration arithmetic and the revert-to-reason mapping. Deliberately NOT
 * testing copy wording (copy lives in examples/ and is reviewed by reading).
 */
import { describe, expect, test } from 'vitest';
import { humanizeDuration, inAbout, resetsIn } from '../../duration.js';
import { reasonFromRevert } from '../../errors.js';
import { millisUntilReset, resetLabel } from '../../generation.js';

const DAY_START = 1_785_024_000n;
const THREE_HOURS = 3 * 60 * 60 * 1000;

describe('durations', () => {
  test('round to the coarsest useful unit', () => {
    expect(humanizeDuration(THREE_HOURS)).toBe('3 hours');
    expect(humanizeDuration(60 * 60 * 1000)).toBe('an hour');
    expect(humanizeDuration(90 * 60 * 1000)).toBe('1.5 hours');
    expect(humanizeDuration(25 * 60 * 1000)).toBe('25 minutes');
    expect(humanizeDuration(24 * 60 * 60 * 1000)).toBe('a day');
  });

  test('never claim precision they do not have', () => {
    expect(humanizeDuration(3_000)).toBe('under a minute');
    expect(humanizeDuration(0)).toBe('any moment now');
    expect(humanizeDuration(-5)).toBe('any moment now');
    expect(inAbout(0)).toBe('any moment now');
  });

  test('both phrasings compose from the same number', () => {
    expect(resetsIn(THREE_HOURS)).toBe('resets in 3 hours');
    expect(inAbout(THREE_HOURS)).toBe('about 3 hours from now');
  });
});

describe('revert mapping', () => {
  test('each contract failure maps to the state a user would act on', () => {
    expect(reasonFromRevert('No sponsored transactions remaining')).toBe('exhausted');
    expect(reasonFromRevert('No sponsorship seats available today')).toBe('no-seats');
    expect(reasonFromRevert('Gas settings exceed the sponsorship allowance')).toBe('fee-spike');
    expect(reasonFromRevert('Generation is not currently sponsorable')).toBe('rollover');
    expect(reasonFromRevert('Sponsored call targets a non-allowlisted contract')).toBe('not-sponsored');
    expect(reasonFromRevert('Sponsorship seat no longer within capacity')).toBe('seat-revoked');
    expect(reasonFromRevert('Player account class is not sponsored')).toBe('not-sponsored');
  });

  test('an unrecognised failure is not forced into a state', () => {
    // Guessing would show confident, wrong guidance for an unrelated bug.
    expect(reasonFromRevert('some unrelated network error')).toBeUndefined();
    expect(reasonFromRevert('')).toBeUndefined();
  });
});

describe('reset arithmetic', () => {
  test('the countdown matches the day boundary', () => {
    expect(resetLabel()).toBe('00:00 UTC');
    expect(millisUntilReset(DAY_START + 86_400n - 60n)).toBe(60_000);
  });
});
