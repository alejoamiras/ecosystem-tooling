# @alejoamiras/aztec-fee-payment

Fee Payment Contract (FPC) for Aztec. This package provides a fully private fee payment strategy for sponsoring transaction fees on behalf of users.

## Installation

```bash
bun add @alejoamiras/aztec-fee-payment
```

## Available Contracts

| Contract | Description | Auth model |
|----------|-------------|-----------|
| **PrivateFPC** | Fully private. Bridge FeeJuice from L1; the claim converts to internal FJ for fee sponsorship. | Cryptographic bridge proof (no owner, no agent) |

## Quick Start

### PrivateFPC

Fully private; no owner and no off-chain agent. Users bridge FeeJuice from L1 to the FPC address, then prove the bridge claim on L2 to credit private FJ balance.

```typescript
import {
  estimateGasSettings,
  FPCFeePaymentMethod,
  PrivateMintAndPayFeePaymentMethod,
  registerPrivateContract,
} from '@alejoamiras/aztec-fee-payment';
import { Fr } from '@aztec/aztec.js/fields';

// Register the PrivateFPC with the PXE — no deployment transaction needed
const salt = Fr.ZERO; // must match the salt used in `bun run compute`
const fpc = await registerPrivateContract(wallet, salt);

// L1: deposit FeeJuice to the portal with a claimer-bound secretHash
// secretHash = computeSecretHash(poseidon2([salt, claimerAddress], DOM_SEP))
// FeeJuicePortal.depositToAztecPublic(_to=fpc.address, _amount, secretHash)

// L2 two-step flow: claim then mint
await feeJuice.methods.claim(fpc.address, amount, secret, leafIndex).send();
await fpc.methods.mint(amount, salt, leafIndex).send();

const paymentMethod = new FPCFeePaymentMethod(fpc.address);
const gasSettings = await estimateGasSettings(
  someContract.methods.doSomething(),
  {
    aztecNode,
    from: userAddress,
    paymentMethod,
    additionalScopes: [fpc.address],
  },
);

// Use internal FJ balance to sponsor transactions
await someContract.methods.doSomething().send({
  from: userAddress,
  additionalScopes: [fpc.address],
  fee: { paymentMethod, gasSettings },
});

// Or cold-start: FeeJuice.claim + mint_and_pay_fee in one transaction (no prior mint needed)
const coldStartPaymentMethod = new PrivateMintAndPayFeePaymentMethod(
  fpc.address,
  amount,
  secret,
  salt,
  leafIndex,
);
const coldStartGasSettings = await estimateGasSettings(
  someContract.methods.doSomething(),
  {
    aztecNode,
    from: userAddress,
    paymentMethod: coldStartPaymentMethod,
    additionalScopes: [fpc.address],
  },
);

await someContract.methods.doSomething().send({
  from: userAddress,
  additionalScopes: [fpc.address],
  fee: {
    paymentMethod: coldStartPaymentMethod,
    gasSettings: coldStartGasSettings,
  },
});
```

## Transaction Behavior

All FPCs handle transaction failures consistently:

| Scenario | Transaction Result | Fee Paid? |
|----------|-------------------|-----------|
| **Private revert** | `INVALID` (not included in block) | No |
| **Public revert** | `APP_LOGIC_REVERTED` | Yes (FPC pays) |
| **Success** | `SUCCESS` | Yes (FPC pays) |

If private logic fails, the transaction is never included — no fees are charged. If the transaction is included and public logic reverts, the fee payer still pays.

## Exports

### Main Entry Point (`@alejoamiras/aztec-fee-payment`)

```typescript
// Contracts
PrivateFPCContract, PrivateFPCContractArtifact

// Fee Payment Methods
FPCFeePaymentMethod                 // pay_fee (no refund)
PrivateMintAndPayFeePaymentMethod   // FeeJuice.claim + mint_and_pay_fee (PrivateFPC)

// Utilities
estimateGasSettings
maxFeesPerGasFromBaseFees, maxPriorityFeesPerGasFromMaxFees, maxGasCostFor
registerPrivateContract
```

### Sub-path Exports

- `@alejoamiras/aztec-fee-payment/artifacts/private` - PrivateFPC contract and artifact
- `@alejoamiras/aztec-fee-payment/fee-payment-methods` - Fee payment methods only
- `@alejoamiras/aztec-fee-payment/utils` - Utility functions only

## License

MIT
