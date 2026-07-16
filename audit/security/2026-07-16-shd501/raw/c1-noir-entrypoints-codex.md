# Cluster C1 — Noir entrypoints and balance flows

## Result

No security findings met the required concrete-trace threshold.

## Scope reviewed

- `packages/aztec-fee-payment/src/nr/private_contract/src/main.nr`: `pay_fee`, `mint_and_pay_fee`, `mint`, `_deduct_max_gas_cost`, `_subtract_balance`, `recurse_subtract_balance_internal`, and `balance_of`.
- `packages/aztec-fee-payment/src/nr/fpc_lib/src/lib.nr`: `get_max_gas_cost`.
- Aztec 5.0.1 dependency semantics used by those paths: private phase counters, fee-payer election, note/nullifier siloing, nullifier-existence requests, `BalanceSet::try_sub`, `#[only_self]`, and FeeJuice claim behavior.

## Security conclusions supporting the result

- **Phase safety:** `pay_fee` produces the balance-note nullifiers/change note before `set_as_fee_payer()` and calls `end_setup()` only afterward (`main.nr:50-57`). `mint_and_pay_fee` likewise proves and re-nullifies the claim, creates the residual-balance note, elects the fee payer, and only then ends setup (`main.nr:77-107`). Aztec 5.0.1 constrains `set_as_fee_payer()` to the non-revertible phase and uses the `end_setup()` side-effect counter as the phase boundary. Consequently, a valid transaction cannot retain fee-payer election while reverting the preceding deduction/credit, or retain those effects while skipping a failing fee-payer election. A failure before `end_setup()` makes the setup transaction unprovable rather than selectively reverting an effect.
- **Bridge backing and authorization:** both mint paths derive the asserted FeeJuice nullifier from `self.address`, the exact `u128 amount`, `salt`, `msg_sender`, `leaf_index`, `chain_id`, and `version` (`main.nr:78-93`, `main.nr:136-156`, `main.nr:293-320`). Existence is requested under `FEE_JUICE_ADDRESS`, so a claim to a different recipient, amount, secret/claimer, index, chain, or version does not satisfy it. The matching FeeJuice claim credits the FPC's public FeeJuice balance by that exact amount. No trace was found by which Bob can turn Alice's deposit into Bob-owned notes without finding a Poseidon2 collision or learning a salt that also yields such a collision under Bob's distinct address.
- **Double consumption:** after proving the FeeJuice-siloed nullifier exists, both mint paths emit the same unsiloed value from the FPC (`main.nr:90-96`, `main.nr:153-161`). The kernel silos each emission by the emitting contract. Thus FeeJuice's prior nullifier and the FPC replay-prevention nullifier occupy distinct domains, while `mint` and `mint_and_pay_fee` collide with each other for the same bridge claim. Concurrent proofs against an old anchor fail on duplicate-nullifier insertion rather than double-crediting.
- **Arithmetic:** `amount >= max_gas_cost` precedes `amount - max_gas_cost` in the cold-start path (`main.nr:100-104`). The ordinary payment path requires constrained note values whose sum covers the computed amount before subtraction/change creation (`main.nr:173-180`, `main.nr:192-201`). Noir's constrained `u128` arithmetic fails proof generation on overflow; it does not provide a wrapping value that could undercharge the caller while charging the shared FPC balance. Caller-selected excessive gas settings therefore fail closed or consume that caller's own balance and do not yield a concrete cross-user griefing path.
- **Recursive subtraction:** recursion is an authenticated self-call (`main.nr:200`, `main.nr:208-212`), and each `BalanceSet::try_sub` constrains the ownership and nullification of selected notes. A direct attacker call fails `#[only_self]`; a valid recursive call can only continue subtracting the account fixed by the initiating entrypoint. Note fragmentation can increase the owner's proving work or make their own payment fail, but no shared availability or fund-loss trace was found.
- **Unconstrained utility:** `balance_of` is a utility-only client-side note view (`main.nr:217-220`). No constrained production function consumes its output, and a PXE cannot view another user's undisclosed notes merely by supplying that user's address. It is therefore not an under-constrained authorization or balance-accounting sink in this scope.
- **No-refund behavior:** charging the full caller-authorized maximum is explicit (`main.nr:46-47`) and preserves or increases the public FeeJuice backing relative to internal liabilities. No route from this policy to unauthorized loss from another user's private balance was found.

## Finding count

**0**
