# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Aztec Fee Payment — a Fee Payment Contract (FPC) for Aztec that sponsors transaction fees using internal balances. Includes a Noir smart contract and a TypeScript SDK (published as `@alejoamiras/private-fee-juice`).

- **Private FPC** (`src/nr/private_contract/`) — Bridge-based flow: users bridge FJ directly via `FeeJuicePortal` to the FPC address, then call `mint` to convert the bridge claim into private FJ. Fully private, no owner, no off-chain agent.

## Spec Guardian

The tech design document in `docs/` is the **source of truth** for this project:
- **Private FPC PRD**: `docs/private-product-requirements.md`

All code changes MUST stay aligned with this document. Two mandatory checks enforce this:

### 1. Pre-Change Validation (BLOCKING)

Before implementing any user-requested code change, launch a read-only `general-purpose` subagent that reads the doc and classifies the proposed change as:
- **ALIGNED** — explicitly described or directly implied by the spec
- **CONTRADICTION** — conflicts with a specific decision/requirement/constraint (must quote the section)
- **EXTENSION** — adds behavior, fields, endpoints, or flows not covered by the doc

**If ALIGNED**: proceed with implementation.
**If CONTRADICTION or EXTENSION**: use `AskUserQuestion` with options: (1) "Proceed and update docs after", (2) "Abort", (3) "Modify approach". Do NOT implement without asking.

Skip this check for: refactors with no behavior change, test-only changes, formatting, dependency bumps.

### 2. Post-Change Doc Sync (AUTOMATIC)

After any code change that affects contract logic, SDK public API, error codes, or security properties, launch a `general-purpose` subagent (with edit permissions) that:
1. Reads the doc and identifies sections made outdated by the change
2. Edits only affected sections (requirements tables, status fields, code examples, API specs, schemas, prose)
3. Bumps the version in the Version History table (minor for features/behavior changes, patch for clarifications) with today's date
4. Returns a summary of all doc edits — relay this summary to the user

## Prerequisites

- Node.js >= 22, bun (workspace member of the ecosystem-tooling monorepo)
- Aztec CLI — version pinned by the repo root `package.json` `config.aztecVersion` (install via `aztec-up install <version>`)

## Commands

```bash
bun install           # Install dependencies (bun workspace, run from the repo root)

# Full rebuild (clean + compile Noir + generate TS bindings)
bun run ccc

# Individual steps
bun run compile          # aztec compile (Noir contracts)
bun run codegen          # aztec codegen target --outdir src/artifacts

# Build TS package (compile + codegen + tsc)
bun run build

# Tests — integration tests require a running Aztec local network
bun run test             # all tests (Noir + JS)
bun run test:nr          # Noir unit tests only (aztec test)
bun run test:js          # JS integration tests

# Run a single test file
bunx vitest run src/ts/test/private.test.ts

# Compute PrivateFPC address (no on-chain deployment needed)
bun run compute          # Requires PRIVATE_FPC_SALT in .env

# Formatting (root-owned)
bun run lint (repo root — biome)
```

## Architecture

### Noir Contracts (`src/nr/`)

Two Noir packages (workspace defined in root `Nargo.toml`):

- **`private_contract`** — Private FPC. Fully private (no public functions). Storage: `balances: Owned<BalanceSet>` only. Key functions:
  - `pay_fee()` — Deducts max gas cost, no refund
  - `mint(amount, salt, leaf_index)` — Proves prior `FeeJuice.claim` via nullifier existence, credits FJ to claimer
  - `balance_of(account)` — Unconstrained view
  - Library methods: `derive_bridge_secret`, `get_bridge_gas_msg_hash`, `compute_feejuice_claim_nullifier`
- **`fpc_lib`** — Shared Noir library (`get_max_gas_cost`), imported by `private_contract`

The sponsored **application** contract that tests and benchmarks exercise is NOT local: it is the stock upstream `@aztec/noir-contracts.js` `SimpleToken` (a devDependency; the FPC sponsors `mint_privately` on it). This replaced the previously-bundled local `counter_contract`, which was deleted — a stock contract needs no maintained Noir crate and never ships to consumers.

### TypeScript SDK (`src/ts/`)

Published as `@alejoamiras/private-fee-juice` with export paths:
- `.` — Main: `PrivateFPCContract`, `FPCFeePaymentMethod`, gas utils, registration helper
- `./artifacts` — Generated contract bindings
- `./fee-payment-methods` — `FPCFeePaymentMethod` (no refund), `PrivateMintAndPayFeePaymentMethod`
- `./utils` — Gas calculation helpers (`maxGasCostFor`, `maxFeesPerGasFromBaseFees`), `registerPrivateContract`

### Test Setup

- **Integration tests** (`vitest.config.ts`) — Requires a running Aztec local network (start manually before running). 200s timeouts. Single fork, no parallelism. Must inline `/@aztec/`, `/@noble/`, `/@scure/`, `/viem/` in `server.deps`.

### Deployment

- PrivateFPC is fully private (no public functions, no constructor) — no on-chain deployment needed
- `scripts/compute.ts` — Computes the deterministic address from artifact + salt (`PRIVATE_FPC_SALT` env var)

## Key Patterns

- `set_as_fee_payer()` + `end_setup()` is the required FPC pattern for Aztec fee sponsorship
- `mint` uses `assert_nullifier_exists` + `compute_nullifier_existence_request` to prove a prior `FeeJuice.claim` in private
- Commits use conventional commits (`@commitlint/config-conventional`)

## Vitest Gotchas

- `encodeEventLog` does NOT exist in the bundled viem — use `encodeEventTopics` + `encodeAbiParameters`
- `vi.mock` for classes must use actual `class` syntax in vitest v4
- Aztec Schnorr signatures use random nonces (NOT deterministic)
- The vitest config requires a `@noble/hashes/utils` resolve alias pointing to the exact ESM file — without it, CI may resolve a nested version missing the `anumber` export
