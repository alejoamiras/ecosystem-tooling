/**
 * The example copy's MACHINERY (not its wording — copy is reviewed by reading).
 */
import { describe, expect, test } from 'vitest';
import { describeQuotaUnavailable, describeSponsored, flattenQuotaMessage } from './messages.js';

describe('example copy', () => {
  test('states a user can act on carry a link; transient ones do not', () => {
    const bridge = 'https://example.invalid/bridge';
    for (const reason of ['exhausted', 'no-seats', 'fee-spike', 'paymaster-empty', 'not-sponsored'] as const) {
      expect(
        describeQuotaUnavailable(reason, { bridgeUrl: bridge }).action?.href,
        `${reason} should offer a way forward`,
      ).toBe(bridge);
    }
    // Waiting is the action for these, so a link would only be noise.
    expect(describeQuotaUnavailable('sync-pending').action).toBeUndefined();
    expect(describeQuotaUnavailable('rollover').action).toBeUndefined();
  });

  test('the sponsor name is a parameter, never baked in', () => {
    const message = describeSponsored('Dark Forest', 3);
    expect(message.headline).toContain('Dark Forest is sponsoring your next 3 transactions');
    expect(describeSponsored('My App', 1).headline).toContain('My App is sponsoring your next 1 transaction,');
  });

  test('flattening joins headline and detail', () => {
    const flat = flattenQuotaMessage({ headline: 'A.', detail: 'B.' });
    expect(flat).toBe('A. B.');
    expect(flattenQuotaMessage({ headline: 'A.' })).toBe('A.');
  });
});
