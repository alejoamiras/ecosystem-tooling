# Integrating the quota paymaster into your app

How a dApp wires up sponsored transactions with `@alejoamiras/quota-paymaster`.
The README covers what the contract IS, its threat model, and the operator CLI;
this covers the client path — the order to call things in, and the four places
where a reasonable-looking integration silently stops sponsoring.

Written to be readable by a coding agent as well as a person. If you are an
agent: read the "Traps" section before writing code, not after.

## Prerequisites

1. **Aztec `5.0.1`.** Versions are LOCKSTEP — `@aztec/*` are exact `5.0.1` peer
   dependencies. A different Aztec version will not resolve, by design.
2. **A 7-day npm min-age gate will reject a fresh release.** If your repo sets
   `minimumReleaseAge` in `bunfig.toml` (a good supply-chain default), a version
   published this week is refused. Wait out the window or add a scoped exception.
   This is expected behaviour, not a broken install.

```bash
bun add @alejoamiras/quota-paymaster
```

## The mental model, in four sentences

The paymaster is the **transaction entrypoint**, not a passive fee payer: it
validates every call in the user-signed payload against an allowlist, does quota
bookkeeping, elects itself fee payer, and then dispatches into the user's own
account entrypoint — so your app still sees the user as `msg_sender`.

Quotas are counted per **generation**, a UTC day index. A user's first sponsored
transaction of a generation claims a **seat** (capacity is `max_users` per day);
subsequent ones spend from `max_uses`. Both are enforced with nullifiers, so the
"has this user subscribed today" question is answered on chain, not in your app.

## The client sequence

```ts
import {
  generationAt, hasSubscribed, findFreeSeat,
  resolveFeeSource, buildSandwichPayload, maxFeePerGasWithHeadroom,
  createSendOnceContext, awaitAllowanceTransition,
  QuotaUnavailableError, reasonFromRevert,
} from '@alejoamiras/quota-paymaster';
```

### 1. Which generation is it?

```ts
const generation = generationAt(chainTimestampSeconds);
```

Use **chain** time, not `Date.now()`. The contract accepts the current generation
and — in the last 600 seconds of a day — tomorrow's, so a transaction built at
23:59 still lands after midnight.

### 2. Who pays?

`resolveFeeSource` makes the decision. Every input is injectable and nothing is
defaulted, because each default would be a policy choice made on your behalf:

```ts
const source = await resolveFeeSource({
  state,                       // { generation, subscribed, remaining, syncing }
  chainTimestampSeconds,
  onSyncing: 'wait',           // or 'self-pay' — see below
  findFreeSeat: () => findFreeSeat({ node, fpcAddress, generation, maxUsers }),
  ownBalance, minSelfPayBalance,
  paymasterBalance, minPaymasterBalance,
});
```

It returns one of:

| result | meaning |
|---|---|
| `{ kind: 'sponsored-first', generation, seat }` | first transaction of the day — claim `seat` |
| `{ kind: 'sponsored', generation }` | spend from an existing allowance |
| `{ kind: 'self' }` | no sponsorship, but the user can pay |
| `{ kind: 'blocked', reason }` | nobody can pay — surface funding options |

`onSyncing` is required and the trade-off is real: `'wait'` blocks until the
wallet has synced enough to answer (correct, slower); `'self-pay'` charges the
user rather than waiting (fast, and occasionally charges someone who did have a
free transaction available).

### 3. Build the sandwich

```ts
const payload = await buildSandwichPayload(
  { calls, player, fpcAddress, generation, seat },  // seat ONLY on the first of the day
  wallet,
  fpcContract,
);
```

At most **5 calls** per transaction (`ACCOUNT_MAX_CALLS`). Omit `seat` once the
user is subscribed — passing one again builds a second subscription against an
existing nullifier, which cannot prove.

### 4. Declare the fee ceiling the policy budgeted for

```ts
const maxFeesPerGas = new GasFees(
  maxFeePerGasWithHeadroom(profile, minFees.feePerDaGas),
  maxFeePerGasWithHeadroom(profile, minFees.feePerL2Gas),
);
```

Use this helper. The contract bills `gas_limits × max_fees_per_gas` **per
dimension**, and the policy's fee floor budgets for exactly the number this
returns. A client that rounds headroom its own way can satisfy the operator's
policy check and still be rejected on chain — the two computations have to agree
by construction, which is why the helper is exported rather than described.

### 5. Send exactly once

```ts
const ctx = createSendOnceContext(nodeUrl);
try {
  await ctx.attemptSend(() => /* simulate + prove + broadcast on ctx.node */);
} catch (err) {
  if (ctx.isRetryableBeforeBroadcast(err)) { /* safe AND useful to retry */ }
  else if (ctx.isProvablyPreBroadcast(err)) { /* nothing was sent */ }
  else { /* a transaction may be in flight — do NOT resend */ }
}
```

`ctx.node`'s transport never retries. That matters because a retried sponsored
transaction can consume a second quota use for one user action. The classifiers
only answer by message for errors raised by **this** context's `attemptSend`, so
a same-looking error from elsewhere is correctly treated as "not provably
pre-broadcast" rather than assumed safe.

### 6. Wait for the allowance to catch up

```ts
const next = await awaitAllowanceTransition({
  generation,
  readState: () => /* re-read { subscribed, remaining } */,
  expectedRemaining: previousRemaining - 1,
  observedSubscribedBefore: true,   // required when expectedRemaining === 0
});
```

The note the transaction just wrote is not immediately visible to the local PXE.
Firing the next send too fast makes a **healthy** paymaster report "no allowance
remaining" purely from outrunning sync — poll for the specific expected
transition instead.

## Traps

These are the four that cost real time. Each is a case where the naive reading is
wrong and the failure is silent or misleading.

**`AllowanceState.subscribed` is not the contract's `has_allowance`.** It means
"already holds a seat this generation". `has_allowance` is `spent < max_uses` and
flips false when the day's uses run out. Map `has_allowance` into `subscribed`
and an *exhausted* user looks unsubscribed, so the client builds
`subscribe_and_execute` against an existing player nullifier — unprovable. Keep
"has a seat" and "has uses left" as separate facts; `remaining` carries the
second.

**`findFreeSeat()` returning `null` means the day is FULL.** It does not mean "no
seat needed". Coercing it to `undefined` sends `sponsor_and_execute` for a user
who never subscribed, which the contract rejects. Treat `null` as
`blocked: 'no-seats'`; capacity frees at the reset.

**A ceiling below the client's fee floor stops sponsorship for everyone,
silently.** There is no on-chain error for it — transactions simply become
unprovable. This is why `GasProfile` is a required input with no default:
`DARK_FOREST_REFERENCE_GAS_PROFILE` is labeled reference data, and a foreign
envelope can approve a ceiling that is wrong for your app. Measure your own
actions (`npx @alejoamiras/quota-paymaster measure …`) and size from that.

**The note is not consumed on the last use.** The contract re-inserts it
unconditionally; only `has_allowance` flips. Do not treat "note gone" as a state
you will ever observe.

## Handling refusals well

`QuotaUnavailableError` carries a `QuotaUnavailableReason`, and each one has a
different honest thing to tell a user:

| reason | what it means | good UX |
|---|---|---|
| `sync-pending` | state not observable yet | retry shortly; do not say "no allowance" |
| `exhausted` | this user's uses are gone for the day | show when it resets |
| `no-seats` | every seat for today is taken | capacity frees at the reset |
| `fee-spike` | fees exceed the per-transaction ceiling | offer self-pay |
| `paymaster-empty` | the paymaster cannot sponsor anything | tell the operator, not the user |
| `rollover` | the clock rolled past the chosen generation | rebuild and retry |
| `not-sponsored` | this call targets a non-allowlisted contract | a bug in your call construction |
| `seat-revoked` | policy narrowed and this seat fell outside the new cap | reset or self-pay |

Use `reasonFromRevert` to classify a revert rather than matching strings
yourself. `resetsIn` / `inAbout` / `humanizeDuration` are exported for the
"try again in about four hours" copy — the SDK deliberately ships no
human-facing strings of its own.

## Operating the paymaster

Deploying, funding, retuning policy and measuring costs are the operator CLI's
job, not your app's:

```bash
npx @alejoamiras/quota-paymaster --help
```

See the README's **Operating** section. Two things worth internalising before you
touch it: every state-changing command prints an ActionPlan digest and does
nothing without `--yes`, and **fee juice sent to a paymaster is unrecoverable** —
there is no withdraw, no pause, no migration. Fund in tranches.

## Before you ship

- [ ] Allowlist contains **only** contracts whose entire callable surface you
      will pay for. Allowlisting a token makes every `transfer` operator-funded;
      put a facade in front if you need finer grain.
- [ ] `requireUnpublishedAccounts` left ON, and only initializerless account
      classes allowlisted. This is what upgrades "the class it was created with"
      into "the class that will execute".
- [ ] `maxFeeWei` sized from **measured** action costs times headroom.
- [ ] The privacy consequences are acceptable to you: the per-user-day nullifier
      is a public membership oracle (anyone holding a candidate address can test
      "did X use sponsorship on day D"), and seat nullifiers make daily usage
      counts public.
- [ ] Funding plan is tranched, and the admin key is treated as part of the
      security model — it retunes policy with a fixed 12-hour delay and cannot be
      transferred.

Full reasoning for each of these is in the README's threat model. Read it before
deploying, not after.
