# Aztec Standards

[![npm version](https://img.shields.io/npm/v/@alejoamiras/aztec-standards.svg)](https://www.npmjs.com/package/@alejoamiras/aztec-standards)

> Continues [defi-wonderland/aztec-standards](https://github.com/defi-wonderland/aztec-standards) (MIT, © Wonderland) as part of the [ecosystem-tooling](https://github.com/alejoamiras/ecosystem-tooling) monorepo. Migrating? `bun add @alejoamiras/aztec-standards` — `artifacts/…`, `target/*.json` and `deployments.json` import paths are unchanged; the duplicated legacy `dist/…` mirror was removed at 5.0.0 (use the identical `artifacts/…` paths).

Aztec Standards is a comprehensive collection of reusable, standardized contracts for the Aztec Network. It provides a robust foundation of token primitives and utilities that support both private and public operations, empowering developers to build innovative privacy-preserving applications with ease.

## Development

**Prerequisite**: Start an Aztec local network in a separate terminal:
```bash
aztec start --local-network
```

**Tests**: `bun run test` runs Noir and JS tests (`bun run test:nr` / `bun run test:js` individually). JS tests expect the network to be running at `http://localhost:8080` (or `NODE_URL`).

**Benchmarks**: `bun run bench` connects to the same running network.

Set `NODE_URL` to override the default (e.g. `http://localhost:9000`).

**deployments.json**: the addresses shipped in `deployments.json` are HISTORICAL (Wonderland-era testnet deployments, pre-5.0.0). They do not correspond to any 5.0.0 network; the file remains published for legacy import-path compatibility only. Canonical 5.0.0 deployments will replace it when they exist (see the repo roadmap).

## Table of Contents
- [Development](#development)
- [Dripper Contract](#dripper-contract)
- [Token Contract](#token-contract)
- [Vault Contract](#vault-contract)
- [NFT Contract](#nft-contract)
- [Escrow Standard Contract & Library](#escrow-standard-contract--library)
- [Future Contracts](#future-contracts)

## Dripper Contract

The `Dripper` contract provides a convenient faucet mechanism for minting tokens into private or public balances. Anyone can easily invoke the functions to request tokens for testing or development purposes.

📖 **[View detailed Dripper documentation](src/dripper/README.md)**

## Token Contract

The `Token` contract implements an ERC-20-like token with Aztec-specific privacy extensions. It supports transfers and interactions explicitly through private balances and public balances, offering full coverage of Aztec's confidentiality features.

We published the [AIP-20 Aztec Token Standard](https://forum.aztec.network/t/request-for-comments-aip-20-aztec-token-standard/7737) to the forum. Feel free to review and discuss the specification there.

📖 **[View detailed Token documentation](src/token_contract/README.md)**

## Vault Contract

The `Vault` contract is a standalone yield-bearing vault that holds an underlying AIP-20 asset and issues AIP-20 share tokens to depositors. The vault and shares token are separate contracts — the vault manages deposit/withdraw/redeem logic while delegating share token operations (mint, burn, transfer) to an external AIP-20 `Token` contract configured with the vault as its minter.

We published the [AIP-4626: Tokenized Vault Standard](https://forum.aztec.network/t/request-for-comments-aip-4626-tokenized-vault/8079) to the forum. Feel free to review and discuss the specification there.

📖 **[View detailed Vault documentation](src/vault_contract/README.md)**

## NFT Contract

The `NFT` contract implements an ERC-721-like non-fungible token with Aztec-specific privacy extensions. It supports transfers and interactions through both private and public ownership, offering full coverage of Aztec's confidentiality features for unique digital assets.

📖 **[View detailed NFT documentation](src/nft_contract/README.md)**

## Escrow Standard Contract & Library

The Escrow Standard contains two elements:
- Escrow Contract: a minimal private contract designed to have keys with which authorized callers can spend private balances of tokens and NFTs compliants with AIP-20 and AIP-721, respectively.
- Logic Library: a set of contract library methods that standardizes and facilitates the management of Escrow contracts from another contract, a.k.a. the Logic contract. 

📖 **[View detailed Escrow documentation](src/escrow_contract/README.md)**

To see examples of Logic contract implementations, such as a linear vesting contract or a clawback escrow contract, see Wonderland's [aztec-escrow-extensions](https://github.com/defi-wonderland/aztec-escrow-extensions) (historical examples).

## Future Contracts

Additional standardized contracts (e.g., staking, governance, pools) will be added under this repository, with descriptions and function lists.