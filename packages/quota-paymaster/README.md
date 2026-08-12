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

**Integrating this into an app?** [`INTEGRATING.md`](./INTEGRATING.md) is the client-side
guide: the order to call things in, and the four places where a reasonable-looking
integration silently stops sponsoring.

Gas budgets are a REQUIRED input (`GasProfile`): measure your own actions with the measure
tooling — `DARK_FOREST_REFERENCE_GAS_PROFILE` is labeled reference data, not a default.
Human-facing copy is deliberately not in the SDK; tested templates live in `examples/` in the
[repository](https://github.com/alejoamiras/ecosystem-tooling) (they are not shipped in the tarball).

A sponsored client must declare `maxFeesPerGas` using `maxFeePerGasWithHeadroom(profile, fee)`.
The contract bills `gas_limits × max_fees_per_gas` per dimension, and the policy's fee floor
budgets for exactly that number — a client that rounds the headroom differently can satisfy
the policy check and still be rejected on-chain.

## Operating

The package ships an operator CLI. **Always invoke it scoped** — the unscoped name
`quota-paymaster` on npm is not this package:

```bash
npm i -D @alejoamiras/quota-paymaster
npx @alejoamiras/quota-paymaster --help
```

### 1. Write a config module (this is where your signer lives)

The CLI never reads keys from the command line and contains no key material of its own.
You write a small module that hands it a wallet; you name that module explicitly on every
invocation:

```js
// quota-paymaster.config.mjs
import { defineOperatorConfig, schnorrAccountFromEnv } from '@alejoamiras/quota-paymaster/operator/config';

const account = schnorrAccountFromEnv();
export default defineOperatorConfig(async () => ({
  ...(await account()),
  // Required by every command that prices the client's envelope: `policy`
  // (including --show, which reports the sequencer reserve) and `measure`,
  // which has no flag for it. Measure YOUR actions — these are placeholders.
  gasProfile: {
    daGasLimit: 50_000,
    l2GasLimit: 6_000_000,
    teardownDaGasLimit: 5_000,
    teardownL2GasLimit: 500_000,
    feeHeadroomMultiplier: 1.5,
  },
}));
```

`deploy`, `bridge` and `claim` need no profile, so `export default defineOperatorConfig(schnorrAccountFromEnv())`
on its own is enough if those are all you run.

`schnorrAccountFromEnv()` reads `ACCOUNT_SECRET_KEY`, `ACCOUNT_SALT`, `ACCOUNT_SIGNING_KEY`
from the environment (optionally `ACCOUNT_ADDRESS` — it cross-checks the derived address
offline and refuses a mismatch before touching the network, plus `NODE_URL`, and
`L1_RPC_URL` + `L1_PRIVATE_KEY` to enable `bridge`). It never generates keys and never
writes them to a project file. Or write the factory yourself: it returns
`{ node, wallet, from, sendOptions?, gasProfile?, l1?, dispose? }`.

A `.mjs`/`.js` config needs nothing extra. A `.ts` config additionally needs the optional
`tsx` dependency, resolvable from where this package is installed.

### 2. Run commands

```bash
CFG=./quota-paymaster.config.mjs
npx @alejoamiras/quota-paymaster policy  --fpc 0x… --config-module $CFG --show
npx @alejoamiras/quota-paymaster deploy  --config ./quota.json --config-module $CFG --yes
npx @alejoamiras/quota-paymaster policy  --fpc 0x… --config-module $CFG --max-uses 3 --max-loss-wei N --yes
npx @alejoamiras/quota-paymaster bridge  --to 0x… --amount 5 --config-module $CFG --yes
npx @alejoamiras/quota-paymaster claim   --for 0x… --config-module $CFG --yes
npx @alejoamiras/quota-paymaster measure --fpc 0x… --target 0x… --artifact ./Target.json --method myFn --config-module $CFG --yes
```

Contributors can run the same CLI from source without building:
`bun scripts/cli.ts <command> --config-module ./examples/local-network.config.mjs …`
(that example config uses a local network's pre-registered test accounts — no keys).

### Safety properties worth knowing

- **Nothing changes state without `--yes`.** Without it the command prints the exact
  ActionPlan and its digest, then stops. That is not a separate dry-run code path — it is
  the confirmation being refused, so it cannot drift from the real one.
- **A config module is code you are choosing to run.** There is deliberately no automatic
  discovery: `--config-module <path>` is required for every command, so running the CLI
  inside a directory you don't control cannot execute a config found there with your keys
  in the environment.
- **Secrets never travel through argv.** `--secret` (in any spelling) is refused outright.
  Bridge claim secrets are fsync-journaled to an owned 0700 directory
  (`~/.quota-paymaster/`, override with `--journal-dir`) BEFORE L1 is touched — the secret
  is the one unrecoverable piece of a deposit — and are never printed.
- **Keys reach disk, and the docs say so.** The Aztec wallet layer stores the account's
  keys in an LMDB store. By default `schnorrAccountFromEnv` puts that store in a private
  0700 temp directory it creates and deletes when the command ends. Set `QUOTA_WALLET_DIR`
  to keep a durable store instead; that directory is held to the same ownership/mode bar
  as the claim-secret journal.
- **Exit codes**: `0` success · `2` refused (plan declined, config rejected, usage error —
  nothing happened) · `1` operational failure.

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
