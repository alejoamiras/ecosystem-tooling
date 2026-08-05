# Reference integration: Dark Forest

The client integration this package was extracted from is
[dfarchon/dark-forest-aztec#37](https://github.com/dfarchon/dark-forest-aztec/pull/37) — a
full game wiring (fee-source resolution, preflight, badge UI, PXE registration). It is the
reference EXAMPLE, not the product. Five safety patterns it proved in production are part
of this SDK; the rest stays app-side.

## The five promoted patterns (in the SDK)

1. **`QuotaUnavailableError` with `retryable`** — every blocked state names itself and says
   whether waiting can help (`sync-pending`/`rollover` are retryable; `exhausted` is not).
2. **The allowance state machine never guesses "exhausted"** (`resolveFeeSource`): the
   player nullifier is read from the NODE (instant), notes from the PXE (lags seconds);
   nullifier-present + note-absent is `syncing`, never "out of transactions". The syncing
   trade-off (wait vs self-pay) is YOUR explicit `onSyncing` policy — DF chose `'self-pay'`
   so play never stalls; the safe generic posture is `'wait'`.
3. **The non-retrying send client** (`createSendOnceContext`): the default transport retries
   1/2/3s, so a rejection string can belong to attempt two while attempt one sits accepted
   in the mempool. Sponsored sends MUST go through the send-once client.
4. **Pre-broadcast failure classification, capability-bound** — only reachable from the
   send-once context, and `Existing nullifier` is deliberately never trusted (it may be the
   user's own action in flight from a reload or second device).
5. **Preflight order: the user's own allowance BEFORE seat availability** — a full day must
   not turn away returning users who still hold transactions.

## Copy templates (in `examples/messages/`)

The DF-reviewed user-facing copy, with the app name parameterized (`describeSponsored('Dark
Forest', …)` reproduces the original). Tested in this repo's unit suite so it cannot rot;
deliberately NOT part of the published SDK, which exposes structured reasons only.

## Operational numbers DF measured (reference, not defaults)

Mainnet, 2026-08-01: spawn 1.89 FJ · give_spaceships 4.60 FJ · a move ~6.58 FJ (64.5% of
the 6M L2 budget). The do-nothing sandwich floor was 0.82-0.85 FJ — 7.7× below a real move:
**budget from YOUR actions (measure tooling), never the harness floor.**
