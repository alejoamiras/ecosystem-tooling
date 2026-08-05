/**
 * READY-MADE user-facing copy for sponsorship states — an EXAMPLE, not SDK.
 *
 * The published SDK deliberately exposes structured reasons only
 * (`QuotaUnavailableError.reason`); what to SAY about them is an app decision.
 * This module is the copy the Dark Forest integration ships (with the app name
 * parameterized — DF passes `appName: "Dark Forest"`), kept here tested so
 * adopters can start from working, reviewed copy instead of a blank page.
 *
 * Two rules shaped all of it:
 *
 * 1. **Never leave the user without a next step.** "You've used today's free
 *    transactions" is a wall. The same fact plus when it lifts and how to skip
 *    the wait is a choice.
 * 2. **Sponsoring, not paying.** "X is paying your fees" invites the question
 *    "with whose money, and what do I owe?". Sponsoring is what is actually
 *    happening and reads as a gift rather than a transaction.
 */

import { inAbout } from '../../src/ts/duration.js';
import type { QuotaUnavailableReason } from '../../src/ts/errors.js';

export interface QuotaAction {
  label: string;
  href?: string;
}

export interface QuotaMessage {
  /** One short line. Assume this may be all the user reads. */
  headline: string;
  /** Optional second sentence with the useful detail. */
  detail?: string;
  /** What the user can do about it, when there is something. */
  action?: QuotaAction;
}

export interface QuotaCopyContext {
  /** Milliseconds until the allowance refreshes, for a human phrase. */
  millisUntilReset?: number;
  /** Where a user goes to add gas themselves. */
  bridgeUrl?: string;
}

function addGasAction(bridgeUrl?: string): QuotaAction {
  return { label: 'Add gas to your account', href: bridgeUrl };
}

/** "they reset daily (about 3 hours from now)" — shared by both describers. */
function whenBackPhrase(millisUntilReset?: number): string {
  return millisUntilReset === undefined ? 'they reset daily' : `they reset daily (${inAbout(millisUntilReset)})`;
}

/** Copy for a user who cannot currently be sponsored. */
export function describeQuotaUnavailable(reason: QuotaUnavailableReason, context: QuotaCopyContext = {}): QuotaMessage {
  const { millisUntilReset, bridgeUrl } = context;
  // "they reset daily" carries the useful fact even when we cannot say when.
  const whenBack = whenBackPhrase(millisUntilReset);

  switch (reason) {
    case 'sync-pending':
      return {
        headline: 'Just checking how many sponsored transactions you have left…',
      };

    case 'exhausted':
      return {
        headline: `You're out of sponsored transactions for now, but ${whenBack}.`,
        detail: "If you'd rather keep going straight away, you can add a little gas to your account.",
        action: addGasAction(bridgeUrl),
      };

    case 'no-seats':
      return {
        headline: `Today's sponsored transactions have all been claimed, and ${whenBack}.`,
        detail: "If you'd rather not wait, adding a little gas to your account lets you keep going now.",
        action: addGasAction(bridgeUrl),
      };

    case 'seat-revoked':
      return {
        headline: 'Sponsorship was narrowed today, so your free transactions have ended early.',
        detail:
          'Your remaining ones will be back at the daily reset. Until then, a little gas in your account keeps you going.',
        action: addGasAction(bridgeUrl),
      };

    case 'fee-spike':
      return {
        headline: 'Network fees have spiked, so sponsoring is paused for the moment.',
        detail:
          'It should pick up again on its own once fees settle, and adding a little gas to your account lets you keep going meanwhile.',
        action: addGasAction(bridgeUrl),
      };

    case 'paymaster-empty':
      return {
        headline: "Sponsored transactions aren't available right now, so transactions will come out of your own gas.",
        detail: 'Adding a little to your account will keep you going.',
        action: addGasAction(bridgeUrl),
      };

    case 'rollover':
      return {
        headline: "Your sponsored transactions have just reset, so we're reloading your allowance.",
        detail: 'This only takes a moment.',
      };

    case 'not-sponsored':
      return {
        headline: "This action isn't covered by sponsorship, so it runs on your own gas.",
        detail: "You can top up your account if you're running low.",
        action: addGasAction(bridgeUrl),
      };
  }
}

/** Copy for a user who IS being sponsored. `appName` names the sponsor. */
export function describeSponsored(appName: string, remaining: number, context: QuotaCopyContext = {}): QuotaMessage {
  const { millisUntilReset } = context;
  const whenBack = whenBackPhrase(millisUntilReset);

  if (remaining <= 0) {
    return {
      headline: `${appName} is sponsoring your transactions today, so you can play without adding any gas.`,
      detail: `Once you've used them, ${whenBack}.`,
    };
  }

  return {
    headline: `${appName} is sponsoring your next ${remaining} transaction${
      remaining === 1 ? '' : 's'
    }, so you can just play — no gas of your own needed.`,
    detail: `If you use them all, ${whenBack}.`,
  };
}

/** Flattens a message for places that can only show one string. */
export function flattenQuotaMessage(message: QuotaMessage): string {
  return [message.headline, message.detail].filter(Boolean).join(' ');
}
