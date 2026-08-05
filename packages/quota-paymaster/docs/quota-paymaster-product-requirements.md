# Quota Paymaster — Product Requirements

**Target Aztec Version: 5.0.1**

## Problem Statement

Apps on Aztec want new users to transact without first bridging fee juice, but the stock
FPCs cannot see what a transaction does and would sponsor anything. Apps need scoped,
budgeted, abuse-bounded fee sponsorship that requires no changes to their contracts.

## Goals

- Sponsor transactions ONLY for allowlisted target contracts and allowlisted, unpublished
  account classes, under per-user daily quotas and a per-transaction fee ceiling.
- Zero changes to sponsored app contracts (`msg_sender` stays the user).
- Retunable policy (12h-delayed, CAS-protected) without redeploying.
- Generic-first published surface: any project deploys, retunes, funds, and measures its own
  paymaster via the SDK + operator library.

## Non-Goals

- Sybil resistance (documented spend bound, not fairness).
- Function-selector-level allowlisting (contract-level by design in v1; a selector-level
  revision is a future contract change ⇒ new class id ⇒ its own blueprint).
- Contract events for policy changes (bundled into that same future revision).
- A published CLI bin (repo-local adapter only in v1).

## Requirements (contract — vendored, not designed here)

The contract is byte-verbatim from the mainnet-proven Dark Forest deployment (class id
`0x115cfdfd…62fc`, chain-verified; see `known-deployments.json` for provenance and the
enumerated, class-id-neutral deviations). Its behavioral requirements are pinned by tests
rather than restated: see the Test Coverage Matrix.

## Requirements (SDK / operator)

- Browser-safe root export; no node builtins outside `./operator` (probe-tested).
- Inconclusive allowance evidence is NEVER reported as exhausted; the syncing trade-off
  (wait vs self-pay) is an explicit caller policy with no default.
- Failure classification is only reachable bound to a non-retrying client.
- Gas budgets are a required caller input; reference numbers are labeled data.
- Every state-changing operator call: immutable ActionPlan → confirm that exact digest →
  revalidate fresh chain reads → send. Fee-floor and max-loss guards on updates as well as
  deploys. Class ids recomputed from installed artifacts, refusing mismatch fail-closed.
- Bridge claim secrets: fsync-journaled (owned 0700 dir, O_NOFOLLOW, locking) BEFORE L1 is
  touched; never printed, never on argv.

## Test Coverage Matrix

| Property | Layer |
|---|---|
| QuotaPayload ↔ AppPayload layout parity + entrypoint-selector golden | TXE + TS unit |
| Generation freshness incl. rollover grace, all boundaries | TXE |
| Fee ceiling (library assert + 1-wei-deploy e2e) | TXE + integration |
| Policy: bootstrap order, CAS, admin gate, sanity on both write paths | TXE + integration |
| 12h activation, clamp, raise-reaches-exhausted, seat eviction | warp |
| UTC-midnight crossing (grace-window subscription survives; old day dies) | warp |
| Account-class binding + upgrade-then-refuse (real registry update) | integration |
| Inclusion-time revert consumes a use without stranding the user | integration |
| Nullifier parity TS ↔ Noir | integration |
| Journal failure modes (symlink, torn line, lock steal, crash replay) | unit |
| Operator refusals (class-id, fee-floor, max-loss, argv secrets) | unit + smoke |
| Lineage: sources + dep lock + artifacts == chain-verified class id | every gate |

## Per-Aztec-bump checklist

On every lockstep bump (`bun scripts/bump-aztec.ts`):

1. `verify:lineage` MUST fail (new toolchain ⇒ recompiled artifact). Recompile; if the class
   id changed, that is a REAL divergence from the live deployment — record the new id and
   its consequences (a redeploy strands the old instance's balance) before proceeding.
2. Re-verify teardown-gas billing semantics against the new `gas_settings.ts` (the fee
   ceiling mirrors `getFeeLimit()`, which does NOT add teardown at 5.0.1).
3. Recompute account class ids (`verifyAccountClassIds` refuses stale configs) — an
   `@aztec/accounts` bump changes them and requires paymaster redeploys.

## Version History

| Version | Date | Notes |
|---|---|---|
| 5.0.1 | 2026-08-05 | Extraction from dark-forest-aztec (worktree-quota-fpc @ f1943d8); chain-verified lineage; §6 gaps closed |
