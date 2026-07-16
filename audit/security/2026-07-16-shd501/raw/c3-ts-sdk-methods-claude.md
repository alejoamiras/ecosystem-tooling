# Cluster C3 — TS SDK fee-payment methods + address/deploy machinery

Package: `@alejoamiras/aztec-fee-payment@5.0.1`
Scope: `src/ts/fee-payment-methods/{private,shared}.ts`, `src/ts/utils/deploy.ts`, `src/ts/index.ts`,
`scripts/compute.ts`, `canonical-deployment.json`, `src/ts/test/canonical.test.ts`, `src/artifacts/PrivateFPC.ts`.

Reviewed against `@aztec/aztec.js@5.0.1` / `@aztec/stdlib@5.0.1` (`DeployMethod`, `ExecutionPayload`,
`mergeExecutionPayloads`, `PublicKeys`) and the Noir source (`src/nr/private_contract/src/main.nr`,
`src/nr/fpc_lib/src/lib.nr`) to ground the TS-side claims in actual contract semantics rather than
speculation.

---

## Finding 1 — Canonical-deployment guard verifies internal self-consistency, not ground truth

**Title**: `canonical.test.ts` is a self-referential fixed point, not an authenticity check — a single
coordinated edit to `canonical-deployment.json` + `README.md` passes CI cleanly and silently redirects
where every future user is told to bridge real funds.

**Impact factors**:
- **Integrity** — HIGH. The canonical address is the single destination the README instructs users to
  send L1 FeeJuice deposits to. Anything that can move that address, undetected, controls where real
  value gets bridged.
- **Confidentiality** — none.
- **Availability** — indirect: funds sent to a wrong/attacker-influenced address are described by the
  project's own docs as **unrecoverable** (`scripts/compute.ts:59-61`), so this is a fund-loss/availability
  issue for the depositor once triggered.
- **Blast radius** — potentially every user of this SDK version who follows the README's canonical
  address (systemic, not per-integration).
- **Exploitability** — requires the ability to land a change across the repo (compromised maintainer
  credentials, a supply-chain compromise of the publish pipeline, or a bad/malicious PR that passes
  review) — not a remote, unauthenticated attack. This is squarely the "over-privileged/insider actor"
  half of the adversarial mandate, not a network attacker.

**Evidence confidence**: High (verified by reading the actual assertions in the test and reasoning through
what set of edits satisfies all three of them simultaneously).

**CWE / OWASP mapping**: CWE-345 (Insufficient Verification of Data Authenticity); OWASP A08:2021
(Software and Data Integrity Failures).

**Trace**:
1. `canonical-deployment.json:2-6` — comment self-describes this file as "machine-asserted by
   `src/ts/test/canonical.test.ts`," implying it is *the* fund-loss guard.
2. `src/ts/test/canonical.test.ts:22-26` — asserts `canonical.aztecVersion === pkg.peerDependencies['@aztec/aztec.js']`. This only checks the JSON agrees with `package.json`, which are both files an author with merge rights can edit together.
3. `src/ts/test/canonical.test.ts:28-36` — asserts `expectedAddress` equals
   `getContractInstanceFromInstantiationParams(PrivateFPCContractArtifact, { salt: canonical.salt, publicKeys: PublicKeys.default(), deployer: AztecAddress.ZERO })`. This is a *derivation-matches-itself*
   check: if `canonical.salt` changes, `expectedAddress` can be regenerated (via `bun run compute`, per
   the file's own instructions) to match the new salt, and the assertion still passes.
4. `src/ts/test/canonical.test.ts:38-48` — asserts the README's "Current canonical" line contains
   `canonical.expectedAddress`. Again self-referential: update the README line together with the JSON and
   this passes.
5. `README.md:75` — the only human-facing anchor ("Current canonical (Aztec 5.0.1): salt `0x…01`, address
   `0x1a6d21ce…`") is drawn from the same JSON the test checks against — there is no independent,
   externally-anchored value (no hash pin to a prior immutable release, no on-chain attestation that this
   is the address that has actually been funded, no second signer/reviewer requirement encoded in the
   test itself).

**Missing control**: an anchor to something *outside* the co-editable file set — e.g., pinning the
previous release's `expectedAddress` in the test and requiring an explicit, reviewed "migration" comment
to change it across a version bump; or a second, independently-computed artifact hash checked into a
different, harder-to-touch location (e.g., a signed release asset) that the test cross-checks.

**Exploit/violation scenario**: A malicious or compromised contributor (or a supply-chain compromise
reaching the repo, e.g. a hijacked maintainer session) opens a PR that changes `canonical-deployment.json`'s
`salt`/`expectedAddress` pair to one the attacker can spend from at the Noir level in some derived
sense, or — more realistically for a "no owner" fully-private contract — to an address that shares the
attacker's actual class/salt combination for a *look-alike* contract the attacker controls off-repo, and
updates the README line to match. `bun run test:js` (which runs `canonical.test.ts`) is green because
every assertion is checking the edited files against each other, not against a fixed prior value. The
change ships in the next patch release; integrators who pull the new version and copy the "Current
canonical" salt/address bridge real FeeJuice to the new address, believing it to be the same trusted
canonical destination as before.

**Preconditions**: write access sufficient to merge a PR touching `canonical-deployment.json` + `README.md`
(+ optionally `package.json`), or a compromised release/publish pipeline. Does **not** require compromising
the Noir contract, the artifact, or any protocol-level primitive.

**Why mitigations fail**: the "DANGER" banner in `scripts/compute.ts:41-85` and the README's DANGER block
are both about *cross-version* address drift (correct and useful for that purpose) — they say nothing
about *same-version* tampering with the canonical salt/address pair itself, and neither is a runtime
check; both are prose read by a human who trusts the file they're reading.

**Instances**: 1 (the guard's design, as a whole).

---

## Finding 2 — The production registration path has zero runtime tie to `canonical-deployment.json`

**Title**: `registerPrivateContract(wallet, salt)` — the function real dApps call at runtime — accepts
any `Fr` salt with no cross-check against the canonical value, and the package does not even expose the
canonical salt/address programmatically for integrators to check against themselves.

**Impact factors**:
- **Integrity** — HIGH per-incident: registering/interacting with the wrong address is indistinguishable
  from success (no on-chain existence check for a contract with "no public functions, no constructor" —
  `deploy.ts:8-11`), so the mistake is invisible until the user tries to spend a balance that isn't there,
  or bridges funds that are then permanently lost (no recovery mechanism, per `scripts/compute.ts:59-61`).
- **Confidentiality** — none.
- **Availability** — funds bridged to the wrong address are unrecoverable (per the project's own
  documentation of the address-derivation model).
- **Blast radius** — per-integration (one wrong app config = that app's users' funds), not systemic like
  Finding 1, but the *guard the repo claims to have* (canonical.test.ts) provides this call path zero
  protection at all.
- **Exploitability** — primarily a self-inflicted operator/config-drift hazard (stale env var, copy-paste
  error, leftover rc-era salt — `canonical-deployment.json:2` itself documents that "rc-era computations
  used operator-local salts and are not canonical," proving this class of mistake has already occurred
  historically in this project). It is also a **social-engineering amplifier**: because the SDK has no
  built-in way to validate a salt against the true canonical value, an attacker who can get a wallet
  integrator to trust a fake "canonical salt" (spoofed docs, fake support channel, malicious fork of the
  README) faces no independent SDK-side check that would catch the deception.

**Evidence confidence**: High.

**CWE / OWASP mapping**: CWE-345 (Insufficient Verification of Data Authenticity); secondary CWE-1173-style
"no safe-default nudging" via the missing export; OWASP A08:2021.

**Trace**:
1. `src/ts/utils/deploy.ts:23-28` — `registerPrivateContract(wallet, salt)` takes an arbitrary `salt: Fr`
   and calls `PrivateFPCContract.deploy(wallet, { salt, universalDeploy: true }).register()` with **no**
   comparison of the resulting address (or the input `salt`) against `canonical-deployment.json`.
2. `packages/aztec-fee-payment/package.json:13-33` (`exports` map) — only `.`, `./artifacts/private`,
   `./fee-payment-methods`, `./utils`, `./package.json` are resolvable subpaths.
   `canonical-deployment.json` is **not** in the `exports` map, even though it is listed in
   `files` (`package.json:34-38`) and therefore ships inside the published tarball. Node's ESM
   resolution rejects any subpath import not present in `exports` once that field exists, so a consumer
   cannot do `import canonical from '@alejoamiras/aztec-fee-payment/canonical-deployment.json'` — the
   value is reachable only by reading prose (the README) and hand-transcribing it.
3. `src/ts/index.ts:26-48` — the public export surface has no `CANONICAL_SALT` / `CANONICAL_ADDRESS`
   constant an integrator could import and assert against before calling `registerPrivateContract`.
4. `README.md`'s own usage example (`registerPrivateContract(wallet, salt)`) shows `salt` as a bare,
   unsourced variable — the documented happy path does not show, in code, where the canonical salt should
   come from, reinforcing that the binding from "the trusted value" to "the value actually passed at
   runtime" is entirely manual.
5. `scripts/compute.ts:32-91` (the DANGER banner) exists only in a script an operator runs manually,
   never in the `registerPrivateContract` code path real applications execute.

**Missing control**: `registerPrivateContract` (or a documented sibling helper) should accept an
optional expected-address parameter and throw if the derived address doesn't match, and/or the package
should export the canonical salt/address as a typed constant from its public API so integrators can
`assert` against it in their own code without hand-copying hex strings from prose.

**Exploit/violation scenario**: An integration has `PRIVATE_FPC_SALT` (or equivalent app config) set to a
stale rc-era value — the project's own changelog-style comment in `canonical-deployment.json:2` confirms
this exact category of value has existed in the wild ("rc-era computations used operator-local salts and
are not canonical"). The app calls `registerPrivateContract(wallet, staleSalt)`. This succeeds
unconditionally — no network call validates that the resulting address is "the" funded canonical
instance, because a fully-private contract with no constructor/public functions has no on-chain existence
to check against. The application proceeds to instruct end users to bridge FeeJuice to this
address (surfaced from `fpc.address`), which is a completely different, likely unfunded/uncontrolled
address than the one documented in the README. Funds sent there are permanently lost, and nothing in
`registerPrivateContract`, `PrivateFPCContract.deploy`, or the type system flags the mismatch.

**Preconditions**: an integrator (developer) either mismanages the salt value locally, or is
socially engineered into using a wrong one; no protocol-level or SDK bug is required — that's exactly
the gap, since the SDK provides no defense-in-depth against it.

**Why mitigations fail**: `canonical.test.ts` (Finding 1) only runs inside this package's own CI — it
protects the repo's *own* README/JSON pair against drifting from each other, but it has no runtime
component and cannot reach into a downstream consumer's app code to validate the salt they actually pass
to `registerPrivateContract`. The DANGER banner in `compute.ts` is prose in a script most integrators
never run (they call the SDK function directly, per the README's own usage example).

**Instances**: 1 (`registerPrivateContract`, `deploy.ts:23-28`), amplified by the missing export
(`package.json` exports map, `index.ts`).

---

## Non-findings (explicitly analyzed, no exploit path — included per audit brief's focus questions)

- **Hand-encoded selectors (`private.ts:50,60`, `shared.ts:29`) — fail-open or fail-closed?**
  Fail-**closed**. `FunctionSelector.fromSignature(...)` computes a selector independent of the target
  artifact; if a hardcoded string drifted from the real ABI, the private-call dispatch would not find a
  matching function in the target contract's compiled artifact and tx simulation/proving fails before
  anything executes (no ability to silently invoke a different function, since the 4-byte selector space
  and small function count on both `FeeJuiceContractArtifact` and `PrivateFPCContractArtifact` make an
  accidental collision with a real, differently-shaped function cryptographically implausible). Verified
  the three hardcoded strings (`claim((Field),u128,Field,Field)`, `mint_and_pay_fee(u128,Field,Field)`,
  `pay_fee()`) are additionally pinned against the live ABI in `src/ts/test/selectors.test.ts` via
  `FunctionSelector.fromNameAndParameters`, confirming they currently match `@aztec/noir-contracts.js`'s
  `FeeJuice.claim` and this package's own `PrivateFPCContractArtifact`. This guard is test-time only (no
  runtime cross-check), but because the failure mode it protects against is fail-closed, that gap is not
  itself exploitable — it would surface as a broken release (denial of the payment flow), not fund loss.

- **ExecutionPayload ordering / call injection (`private.ts:45-72`)**: not reorderable or injectable.
  `PrivateMintAndPayFeePaymentMethod.getExecutionPayload()` returns a hardcoded 2-element `calls` array
  (`claim` then `mint_and_pay_fee`) with no caller-supplied ordering hook. Traced `mergeExecutionPayloads`
  (`@aztec/stdlib/src/tx/execution_payload.ts:37-61`) and its call sites (e.g.
  `contract_function_interaction.ts:109`: `mergeExecutionPayloads([feeExecutionPayload,
  functionExecutionPayload])`) — the fee payment method's calls are always concatenated *before* the
  app's own calls, framework-wide, so app logic cannot execute ahead of the bundled `claim`/
  `mint_and_pay_fee` setup calls. No injection point exists in the audited files.

- **`amount`/`secret`/`leafIndex`/`salt` mismatch (constructor args, `private.ts:26-32`)**: the SDK does
  not verify `secret == derive_bridge_secret(salt, callerAddress)` before submission (traced the relation
  in `src/nr/fpc_lib/src/lib.nr:234-236,293-321` and `src/nr/private_contract/src/main.nr:77-108`). A
  caller who supplies inconsistent values (including an accidental `secret`/`salt` positional swap — both
  same-typed `Fr`, not caught by tsc) causes either `FeeJuice.claim` itself to fail (secret/secretHash
  mismatch) or `mint_and_pay_fee`'s recomputed `feejuice_nullifier` to not match the actually-emitted one,
  tripping `assert_nullifier_exists` — fail-closed in both cases. No path to silent fund misdirection from
  parameter confusion.

- **`universalDeploy` conditionality / `PublicKeys.default()` fixation**: `registerPrivateContract` hardcodes
  `universalDeploy: true` unconditionally (`deploy.ts:24-27`) and never passes `publicKeys`, `deployer`,
  or `immutablesHash`, so it can only vary by `salt`. Traced `DeployMethod.create` /
  `UniversalDeployMethod` (`aztec.js/src/contract/deploy_method.ts:341-347,734-768`): `universalDeploy: true`
  unconditionally locks `deployer = AztecAddress.ZERO` with no code path to override it, and
  `publicKeys` defaults to `PublicKeys.default()` when omitted — the same call `compute.ts:23-28` and
  `canonical.test.ts:29-34` make explicitly. Confirmed `PublicKeys.default()` (`stdlib/src/keys/public_keys.ts:111-125`)
  returns fixed protocol constants (`DEFAULT_*_HASH`/`DEFAULT_*_X/Y`), not randomized — so
  `registerPrivateContract`, `compute.ts`, and `canonical.test.ts` all derive from the same fixed
  `(deployer=ZERO, publicKeys=default)` pair; the **only** variable across all three is the `salt` value
  itself, which is exactly the axis Finding 2 is about. The raw `PrivateFPCContract.deploy` export *can*
  be called by a consumer with `deployer: <addr>` directly (bypassing the wrapper), which would produce a
  different, non-canonical address — but this is a generic, correctly-typed, intentionally-general Aztec
  contract-deploy primitive (same as any other codegen'd contract), not something `registerPrivateContract`
  can prevent short of not exporting `PrivateFPCContract` at all (which would break other legitimate
  uses, e.g. `PrivateFPCContract.at(...)`). Not counted as a separate finding; it is subsumed by Finding 2's
  root cause (no runtime canonical check anywhere in the deploy/register surface).

- **Secret leakage via logs/serialization**: no `console.log`, template-string interpolation, or
  serialization of `this.secret` (or any constructor field) exists in `private.ts`, `shared.ts`,
  `deploy.ts`, or `compute.ts`. `compute.ts`'s banner only prints the `salt` and derived `address`, never
  a bridge secret (which isn't even a parameter to that script). The generic TS/JS fact that a `private
  readonly` class field remains an enumerable own-property at runtime (so a hypothetical
  `console.log(paymentMethod)` by *consumer* code would dump it) is a language-level property common to
  virtually every class in this ecosystem holding secret material, not a defect introduced by this SDK —
  excluded per "framework defaults w/o bypass."

- **Salt injection via `PRIVATE_FPC_SALT` env var (`compute.ts:33-38`)**: `Fr.fromString(saltEnv)` parses
  the value as a field element and throws on malformed input (fail-closed); no shell/path/command
  injection surface — it is never passed to a subprocess, file path, or template.
