# Aztec Fee Payment Contracts

A Fee Payment Contract (FPC) for Aztec that enables private transaction fee sponsorship via FeeJuice.

## Overview

| Contract | Description | Auth model |
|----------|-------------|-----------|
| **PrivateFPC** | Fully private. Users bridge FeeJuice from L1; the bridge claim converts to internal FJ balance for fee sponsorship. | Cryptographic bridge proof (no owner, no agent) |

## Project Structure

```
├── src/
│   ├── artifacts/                   # Generated contract bindings
│   ├── nr/                          # Noir smart contracts
│   │   ├── counter_contract/        # Test utility contract
│   │   └── private_contract/        # PrivateFPC
│   └── ts/                          # TypeScript package
│       ├── fee-payment-methods/     # Fee payment method classes
│       ├── utils/                   # Utilities (gas, deploy)
│       └── test/                    # Integration tests
├── target/                          # Compiled contract artifacts
├── benchmarks/                      # Performance benchmarks
└── docs/                            # Product requirements
```

## Setup

### Prerequisites

- [Aztec CLI](https://docs.aztec.network/getting_started) — version pinned by the repo root `package.json` `config.aztecVersion`
- Node.js 22+
- Yarn 1.22+

### Installation

```bash
yarn install
```

### Compile Contracts

```bash
# Full rebuild: compile Noir + generate TS bindings
yarn ccc

# Or step by step
aztec compile
aztec codegen target --outdir src/artifacts
```

## Testing

Start the Aztec sandbox:

```bash
aztec start --local-network
```

Run all tests:

```bash
yarn test        # Noir unit tests + JS integration tests
yarn test:nr     # Noir unit tests only
yarn test:js     # JS integration tests only
```

## Deployment

PrivateFPC is a **fully private** contract — it has no public functions and no constructor. This means **no on-chain deployment transaction is required**. The contract address is computed deterministically from its class hash and a salt, and users interact with it privately by address.

### Compute the address

1. Copy `.env.example` to `.env` and set `PRIVATE_FPC_SALT`:
   ```bash
   cp .env.example .env
   ```

2. Compile the contracts (required on first run):
   ```bash
   yarn ccc
   ```

3. Run the compute script:
   ```bash
   yarn compute
   ```

> **DANGER:** The address is derived from compiled bytecode. A different Aztec version produces different bytecode and a **different address**. Sending funds to the wrong address means **unrecoverable loss**. Before using this address, verify the target network runs the same Aztec version as the one shown in the script output:
> ```bash
> curl -s -X POST <NODE_URL> -H 'Content-Type: application/json' \
>   -d '{"jsonrpc":"2.0","method":"node_getNodeInfo","id":1,"params":[]}' \
>   | jq .result.nodeVersion
> ```

## Usage

```bash
bun add @alejoamiras/aztec-fee-payment
```

See [src/ts/README.md](src/ts/README.md) for detailed SDK documentation.

```typescript
import {
  PrivateFPCContract,
  FPCFeePaymentMethod,
  PrivateMintAndPayFeePaymentMethod,
  registerPrivateContract,
} from '@alejoamiras/aztec-fee-payment';

// Register the PrivateFPC — no deployment transaction needed (fully private contract)
const fpc = await registerPrivateContract(wallet, salt);

// --- L1: deposit to FeeJuicePortal with a claimer-bound secretHash ---
// secretHash = computeSecretHash(poseidon2([salt, claimerAddress], DOM_SEP))
// FeeJuicePortal.depositToAztecPublic(_to=fpc.address, _amount, secretHash)

// --- L2: two-step flow ---
// Step 1: claim FeeJuice on L2 (emits FeeJuice nullifier)
await feeJuice.methods.claim(fpc.address, amount, secret, leafIndex).send();

// Step 2: mint internal FJ balance by proving the bridge claim
await fpc.methods.mint(amount, salt, leafIndex).send();

// User sponsors a transaction from their internal balance
await myContract.methods.doSomething()
  .send({ fee: { paymentMethod: new FPCFeePaymentMethod(fpc.address) } });

// --- Cold-start: claim + mint + pay fee in one transaction ---
await myContract.methods.doSomething()
  .send({
    fee: {
      paymentMethod: new PrivateMintAndPayFeePaymentMethod(
        fpc.address, amount, secret, salt, leafIndex,
      ),
    },
  });
```

## Benchmarks

```bash
yarn benchmark
```

Benchmarks are defined in `Nargo.toml` under `[benchmark]` and run against a live local network. Each contract has its own benchmark file in `benchmarks/`.

## License

MIT
