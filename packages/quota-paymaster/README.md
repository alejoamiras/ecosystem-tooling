# @alejoamiras/quota-paymaster

A **quota paymaster** for Aztec: an app deploys and funds it, and it pays its users'
transaction fees — up to N transactions per user per UTC day, at most M distinct users per
day, and **only** for transactions whose every call targets an allowlisted contract. New
users transact without ever bridging. The contract is app-agnostic: all app-specifics
(allowlist, quotas, admin) are constructor arguments fed from a JSON config.

| | |
|---|---|
| Contract | `QuotaFpc` (Noir), class id `0x115cfdfdc4e440c11f040af7e9c980c0e61858b86daeacfe9765a9be613a62fc` |
| Lineage | Byte-verbatim from the live Aztec mainnet deployment; class id verified against the chain (see `known-deployments.json`) |
| Versioning | Lockstep with Aztec: package `5.0.1` targets Aztec `5.0.1` |
| SDK | Browser-safe root export; Node-only `./operator` export |

## The "sandwich" (how it works)

Aztec's stock FPCs cannot see *what* a transaction does, so they would sponsor anything.
This contract is the **transaction entrypoint** instead:

1. Validates every call in the user-signed payload against the target allowlist.
2. Checks the user's **account class** is allowlisted AND the account is **unpublished**.
3. Does quota bookkeeping (notes + nullifiers, all in the non-revertible setup phase).
4. Asserts the fee ≤ `max_fee`, elects itself fee payer, ends setup.
5. Dispatches into the **user's own account entrypoint** with the payload they signed — so
   the app still sees the user as `msg_sender`. Zero changes to app contracts.

## Threat model — read before deploying

- **Allowlist semantics are CONTRACT-LEVEL.** Allowlisting a contract sponsors its ENTIRE
  callable surface. Never allowlist a contract with functions you would not pay for —
  a token contract, for instance, would make every `transfer` operator-funded. If you need
  finer grain, put a facade contract in front and allowlist the facade.
- **The account-class binding needs BOTH checks.** The class allowlist alone binds only the
  account's ORIGINAL class, while execution follows its CURRENT one — a published account
  can call `ContractInstanceRegistry::update` and swap its code. `requireUnpublishedAccounts`
  (default ON, keep it on) is what upgrades "the class it was created with" into "the class
  that will execute". Consequence: only initializerless account classes (which never
  publish) are sponsorable; the plain Schnorr class must NOT be allowlisted. This full
  attack path is regression-tested (`upgrade-then-refuse`).
- **Funds sent to a paymaster are unrecoverable.** Fee juice is protocol-non-transferable:
  no withdraw, no pause, no migration — a class change strands the balance forever. **Fund
  LAST**: deploy → verify tooling drives the instance → audit → small canary → tranches.
  The admin can redirect sponsorship (12h delay) but can never touch the balance.
- **The admin key is part of the security model.** The admin address is a constructor
  immutable with NO transfer function; it retunes policy + allowlist with a fixed 12-hour
  delay (nobody, admin included, can shorten it — and there is no pause lever).
- **The sequencer reserve is a floor, not a budget.** A transaction is admitted only if the
  fee payer holds the worst-case fee for the client's gas envelope. A paymaster funded below
  that sponsors NOTHING while looking healthy — `policy --show` reports it.
- **No sybil resistance.** Accounts are free; the caps are a spend bound, not fairness. The
  sharpest form: the last 600s of a day accept tomorrow's generation, so tomorrow's seats
  can be squatted tonight, nightly, at the paymaster's expense.
- **Privacy disclosures** (this is a privacy ecosystem — say them): the per-user-day
  nullifier is a public *membership oracle* (anyone holding a candidate address can test
  "did X use sponsorship on day D"); seat nullifiers make daily usage counts public; the
  shared fee payer is a privacy *gain* for users.
- **Griefing**: anyone holding a user's address preimage can publish that instance,
  permanently ending sponsorship for that user (metadata leak, not takeover).
- **Your RPC endpoint is trusted.** The operator library revalidates every action plan
  against fresh chain reads (defeats staleness and races), but a consistently lying node
  can still fake deploy/policy state. Operate against an endpoint you trust.
- **A reverting app call still costs the paymaster and a quota use.** Deliberate: reverts
  must not be free rides. The user keeps their seat and the rest of their allowance.

## Reference deployment (Dark Forest, Aztec mainnet)

`known-deployments.json` records the live instance this contract was extracted from —
including the chain verification of the class id. **Funding that instance is an
irreversible donation to Dark Forest.** Deploy your own.

## Usage

Browser-safe SDK (allowance state machine, sandwich builder, seat picker, failure
classification bound to a non-retrying client):

```ts
import {
  buildSandwichPayload,
  createSendOnceContext,
  generationAt,
  resolveFeeSource,
} from '@alejoamiras/quota-paymaster';
```

Node-only operator library (dependency-injected; every state-changing call goes through a
confirm-exact-plan / revalidate-before-broadcast protocol):

```ts
import { deployQuotaFpc, readPolicyState, bridgeFeeJuice } from '@alejoamiras/quota-paymaster/operator';
```

Gas budgets are a REQUIRED input (`GasProfile`): measure your own actions with the measure
tooling — `DARK_FOREST_REFERENCE_GAS_PROFILE` is labeled reference data, not a default.
Human-facing copy is deliberately not in the SDK; tested templates live in `examples/`.

## Operating

A repo-local CLI wraps the operator library (not published; local networks):

```bash
bun scripts/cli.ts deploy  --config examples/quota-config.example.json      # validates, confirms by plan digest
bun scripts/cli.ts policy  --fpc 0x… --show                                  # live + pending policy, balance vs reserve
bun scripts/cli.ts bridge  --to 0x… --amount-wei N                           # secret journaled BEFORE L1 is touched
bun scripts/cli.ts claim   --for 0x…                                         # secret from the journal — NEVER argv
```

Bridge claim secrets are fsync-journaled to an owned 0700 directory
(`~/.quota-paymaster/`) before L1 is touched — the secret is the ONE unrecoverable piece of
a deposit. Secrets are never printed and never accepted on the command line.

## Development

```bash
bun run ccc            # clean + compile (aztec compile) + codegen
bun run test:nr        # Noir TXE suite (28 tests; never concurrently with a live network)
bun run test:js        # unit + live-network integration (needs a local network)
bun run test:warp      # time-travel suite — self-provisions its own disposable network
bun run verify:lineage # source-hash + dep-lock + artifact class id vs the chain-verified one
```

`verify:lineage` binds the vendored sources, the locked Nargo dependency, and both compiled
artifacts to the chain-verified class id — a source edit without recompile, a stale
artifact, or any deviation beyond the enumerated ones fails it.

## Provenance & license

Extracted from the author's Dark Forest integration
([dfarchon/dark-forest-aztec#37](https://github.com/dfarchon/dark-forest-aztec/pull/37));
all vendored files are the author's own contributions, relicensed MIT here. Full provenance
(source commit, per-file hashes, sanctioned deviations) in `known-deployments.json`.
