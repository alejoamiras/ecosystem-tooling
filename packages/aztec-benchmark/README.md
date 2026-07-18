# Aztec Benchmark
[![npm version](https://img.shields.io/npm/v/@alejoamiras/aztec-benchmark.svg)](https://www.npmjs.com/package/@alejoamiras/aztec-benchmark)

**CLI tool and reusable CI workflows for running Aztec contract benchmarks.**

Use the CLI to execute benchmark files written in TypeScript. For CI integration, this repository provides **reusable GitHub workflows** that handle the full benchmark-and-compare cycle — including environment setup, baseline management, and PR commenting — so consumer repos can integrate with a single `uses:` line.

## Table of Contents

- [Installation](#installation)
- [CLI Usage](#cli-usage)
  - [Configuration (`Nargo.toml`)](#configuration-nargotoml)
  - [Options](#options)
  - [Examples](#examples)
- [Writing Benchmarks](#writing-benchmarks)
- [Benchmark Output](#benchmark-output)
- [Reusable Workflows](#reusable-workflows)
  - [PR Benchmark (`pr-benchmark.yml`)](#pr-benchmark-pr-benchmarkyml)
  - [Update Baseline (`update-baseline.yml`)](#update-baseline-update-baselineyml)
  - [How Baselines Work](#how-baselines-work)
- [Action Usage (Advanced)](#action-usage-advanced)
  - [Inputs](#inputs)
  - [Outputs](#outputs)

---

## Installation

```sh
bun add -D @alejoamiras/aztec-benchmark
# or
npm install --save-dev @alejoamiras/aztec-benchmark
```

---

## CLI Usage

After installing, run the CLI using `npx aztec-benchmark`. By default, it looks for a `Nargo.toml` file in the current directory and runs benchmarks defined within it.

```sh
npx aztec-benchmark [options]
```

### Configuration (`Nargo.toml`)

Define which contracts have associated benchmark files in your `Nargo.toml` under the `[benchmark]` section:

```toml
[benchmark]
token = "benchmarks/token_contract.benchmark.ts"
another_contract = "path/to/another.benchmark.ts"
```

The paths to the `.benchmark.ts` files are relative to the `Nargo.toml` file.

### Options

- `-c, --contracts <names...>`: Specify which contracts (keys from the `[benchmark]` section) to run. If omitted, runs all defined benchmarks.
- `--config <path>`: Path to your `Nargo.toml` file (default: `./Nargo.toml`).
- `-o, --output-dir <path>`: Directory to save benchmark JSON reports (default: `./benchmarks`).
- `-s, --suffix <suffix>`: Optional suffix to append to report filenames (e.g., `_pr` results in `token_pr.benchmark.json`).
- `--skip-proving`: Skip proving transactions. Only measures gate counts and gas; proving time will be `0` in reports. When enabled, the `wallet` is not required in the benchmark context.

### Examples

Run all benchmarks defined in `./Nargo.toml`:
```sh
npx aztec-benchmark 
```

Run only the `token` benchmark:
```sh
npx aztec-benchmark --contracts token
```

Run `token` and `another_contract` benchmarks, saving reports with a suffix:
```sh
npx aztec-benchmark --contracts token another_contract --output-dir ./benchmark_results --suffix _v2
```

---

## Writing Benchmarks

Benchmarks are TypeScript classes extending `BenchmarkBase` from this package.
Each entry in the array returned by `getMethods` can either be a plain `ContractFunctionInteractionCallIntent` 
(in which case the benchmark name is auto-derived) or a `NamedBenchmarkedInteraction` object 
(which includes the `interaction` and a custom `name` for reporting).

### Fee Payment

By default, every benchmarked account must hold Fee Juice (FJ) to pay for transaction fees. If your accounts don't have pre-existing FJ (e.g. freshly-created accounts on sandbox), you can return a `feePaymentMethod` from `setup()` inside the `BenchmarkContext`. The profiler will pass it to every `send()` and `proveInteraction()` call automatically.

The sandbox ships with a canonical `SponsoredFPC` contract that has FJ and can sponsor fees for any account — making it the easiest way to get benchmarks running without bridging from L1.

```ts
import {
  Benchmark, // Alias for BenchmarkBase
  type BenchmarkContext,
  type NamedBenchmarkedInteraction
} from '@alejoamiras/aztec-benchmark';
import type { PXE } from '@aztec/pxe/server';
import type { Contract } from '@aztec/aztec.js/contracts'; // Generic Contract type from Aztec.js
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { ContractFunctionInteractionCallIntent } from '@aztec/aztec.js/authorization';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { createStore } from '@aztec/kv-store/lmdb-v2';
import { createPXE, getPXEConfig } from '@aztec/pxe/server';
import { createAztecNodeClient, waitForNode } from '@aztec/aztec.js/node';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { registerInitialLocalNetworkAccountsInWallet } from '@aztec/wallets/testing';
// import { YourSpecificContract } from '../artifacts/YourSpecificContract.js'; // Replace with your actual contract artifact

// 1. Define a specific context for your benchmark (optional but good practice)
interface MyBenchmarkContext extends BenchmarkContext {
  pxe: PXE;
  wallet: EmbeddedWallet;
  deployer: AztecAddress;
  contract: Contract; // Use the generic Contract type or your specific contract type
  feePaymentMethod?: FeePaymentMethod;
}

export default class MyContractBenchmark extends Benchmark {
  // Runs once before all benchmark methods.
  async setup(): Promise<MyBenchmarkContext> {
    console.log('Setting up benchmark environment...');

    const { NODE_URL = 'http://localhost:8080' } = process.env;
    const node = createAztecNodeClient(NODE_URL);
    await waitForNode(node);
    const l1Contracts = await node.getL1ContractAddresses();
    const config = getPXEConfig();
    const fullConfig = { ...config, l1Contracts };
    // IMPORTANT: true enables proof generation for the benchmark, set it to false when using --skip-proving
    fullConfig.proverEnabled = true;
    // PXE wipes any store whose schema version differs from the running PXE's (Aztec 5.0.0+
    // resets on upgrade) — a hardcoded version can resurrect or mask a stale store, so use a
    // fresh dataDirectory per toolchain version when in doubt.
    const pxeVersion = 2;
    const store = await createStore('pxe', pxeVersion, {
      dataDirectory: 'store',
      dataStoreMapSizeKb: 1e6,
    });

    const pxe: PXE = await createPXE(node, fullConfig, { store });
    // `EmbeddedWalletOptions` uses a unified `pxe` field for PXE config and dependency overrides.
    const wallet: EmbeddedWallet = await EmbeddedWallet.create(node, { pxe: fullConfig });
    const accounts: AztecAddress[] = await registerInitialLocalNetworkAccountsInWallet(wallet);
    const [deployer] = accounts;
    
    //  Deploy your contract (replace YourSpecificContract with your actual contract class).
    //  `DeployMethod.send()` now always returns `{ contract, receipt, instance }`.
    const { contract } = await YourSpecificContract
      .deploy(wallet, /* constructor args */)
      .send({ from: deployer });
    console.log('Contract deployed at:', contract.address.toString());

    // Optional: use SponsoredFPC so accounts don't need pre-existing Fee Juice.
    // The sandbox ships with a canonical SponsoredFPC pre-deployed at a deterministic address.
    //
    // import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee/testing';
    // import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
    // import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
    //
    // const instance = await getContractInstanceFromInstantiationParams(
    //   SponsoredFPCContract.artifact,
    //   { salt: new Fr(0n) },
    // );
    // await wallet.registerContract(instance, SponsoredFPCContract.artifact);
    // const feePaymentMethod = new SponsoredFeePaymentMethod(instance.address);

    return { pxe, wallet, deployer, contract /*, feePaymentMethod */ }; 
  }

  // Returns an array of interactions to benchmark. 
  getMethods(context: MyBenchmarkContext): Promise<Array<ContractFunctionInteractionCallIntent | NamedBenchmarkedInteraction>> {
    // Ensure context is available (it should be if setup ran correctly)
    if (!context || !context.contract) {
      // In a real scenario, setup() must initialize the context properly.
      // Throwing an error or returning an empty array might be appropriate here if setup failed.
      console.error("Benchmark context or contract not initialized in setup(). Skipping getMethods.");
      return [];
    }
    
    const { contract, deployer } = context;
    const recipient = deployer; // Example recipient

    // Replace `contract.methods.someMethodName` with actual methods from your contract.
    const interactionPlain = { caller: deployer, action: contract.methods.transfer(recipient, 100n) }
    const interactionNamed1 = { caller: deployer, action: contract.methods.someOtherMethod("test_value_1") };
    const interactionNamed2 = { caller: deployer, action: contract.methods.someOtherMethod("test_value_2") };

    return [
      // Example of a plain interaction - name will be auto-derived
      interactionPlain,
      // Example of a named interaction
      { interaction: interactionNamed1, name: "Some Other Method (value 1)" }, 
      // Another named interaction
      { interaction: interactionNamed2, name: "Some Other Method (value 2)" }, 
    ];
  }

  // Optional cleanup phase
  async teardown(context: MyBenchmarkContext): Promise<void> {
    console.log('Cleaning up benchmark environment...');
    if (context && context.pxe) { 
      await context.pxe.stop(); 
    }
  }
}
```

**Note:** Your benchmark code needs a valid Aztec project setup to interact with contracts.
Your `BenchmarkBase` implementation is responsible for constructing the `ContractFunctionInteractionCallIntent` objects.
If you provide a `NamedBenchmarkedInteraction` object, its `name` field will be used in reports. 
If you provide a plain `ContractFunctionInteractionCallIntent`, the tool will attempt to derive a name from the interaction (e.g., the method name).
If you return a `feePaymentMethod` in the `BenchmarkContext`, it is automatically passed to every transaction the profiler sends — no changes to `getMethods` are needed.

### Usage Example

See how this monorepo benchmarks its own contracts in [`packages/private-fee-juice/benchmarks`](https://github.com/alejoamiras/ecosystem-tooling/tree/main/packages/private-fee-juice/benchmarks).

---

## Benchmark Output

Your `BenchmarkBase` implementation is responsible for measuring and outputting performance data (e.g., as JSON). The comparison action uses this output.
Each entry in the output will be identified by the custom `name` you provided (if any) or the auto-derived name.

---

## CI Integration

### Inside this monorepo

The per-package gate (`private-fee-juice.yml`) calls the repo's reusable workflows:

- **`_pr-benchmark.yml`** — on every PR: runs the suites on the PR head (`--skip-proving`), downloads the `main` baseline artifact, generates a comparison report (regressions beyond 2.5% highlighted), and posts it as a PR comment. Security split: the job executing PR code is read-only; a separate write-permission job posts the comment without executing anything from the PR.
- **`_update-baseline.yml`** — on pushes to `main` (+ monthly cron via `update-baselines.yml`): refreshes the baseline artifacts (`benchmark-baseline-<package>-main`).

Wiring a new package: add a `benchmark` job to its gate workflow:

```yaml
benchmark:
  needs: changes
  if: needs.changes.outputs.relevant == 'true' && github.event_name == 'pull_request'
  permissions:
    contents: read
    pull-requests: write
    issues: write
    actions: read
  uses: ./.github/workflows/_pr-benchmark.yml
  with:
    package-dir: packages/<your-package>
    pr-workflow: <your-package>.yml
```

### From other repositories

The reusable workflows reference this repo's local `setup-aztec` action, so they are not directly callable cross-repo. External projects have two options:

1. **Use the CLI directly** (recommended): install `@alejoamiras/aztec-benchmark` as a devDependency, add a `[benchmark]` table to your `Nargo.toml`, and run `aztec-benchmark --suffix _base` in a job that has an Aztec local network running. The comparison helper is importable as `require('@alejoamiras/aztec-benchmark/action/comparison.cjs')` — see `_pr-benchmark.yml` in this repo as a reference implementation for baselines, comparison and PR comments.
2. **Vendor the workflows**: copy `_pr-benchmark.yml`, `_update-baseline.yml` and `.github/actions/setup-aztec/` into your repo and adjust `package-dir`.
