# Security map: packages/aztec-fee-payment @5.0.1
(Full Phase-1 map — see below. Clusters derived for Phase 2:)

- C1 Noir FPC entrypoints + phase/nullifier/balance flows (main.nr pay_fee/mint/mint_and_pay_fee/_deduct/_subtract/recurse, fpc_lib get_max_gas_cost)
- C2 Noir bridge/crypto derivation (derive_bridge_secret, get_bridge_gas_msg_hash, compute_feejuice_claim_nullifier, DOM_SEP, FEE_JUICE_ADDRESS, comptime keccak selector)
- C3 TS SDK fee-payment methods + address/deploy machinery (private.ts, shared.ts, deploy.ts, index.ts, canonical-deployment.json, compute.ts, PublicKeys.default/universalDeploy)
- C4 TS SDK network/artifact trust surface (artifactRegistry.ts fetch-without-validation, gas.ts estimateGasSettings node trust, upload-artifact.ts) + packaging surface (counter_contract-Counter.json ships in tarball)

---
## Key trust boundaries (from Phase-1 mapper)
- Noir: msg_sender sole authz (no owner/allowlist); attacker-controlled amount/salt/leaf_index validated only via assert_nullifier_exists; push_nullifier_unsafe for double-spend prevention; hardcoded FEE_JUICE_ADDRESS + comptime keccak "claim(bytes32,uint256)" selector; get_max_gas_cost from context.gas_settings (self-harm griefing bound); balance_of unconstrained (view only).
- Entrypoints: pay_fee(main.nr:48-58), mint_and_pay_fee(75-108), mint(134-167) — only first two #[allow_phase_change]; internal _deduct_max_gas_cost(172), _subtract_balance(191), recurse_subtract_balance_internal(208 only_self).
- TS: artifactRegistry.ts fetchArtifactFromRegistry returns unknown cast to NoirCompiledContract with NO schema/hash/signature validation (:131-170) — reachable via deep import, not in exports map; gas.ts estimateGasSettings trusts node getCurrentMinFees/txsLimits (self-harm overpay); selectors hand-encoded (guarded by selectors.test.ts only at test time); compute.ts PRIVATE_FPC_SALT wrong-version⇒fund-loss (guarded by canonical.test.ts).
- Packaging: target/counter_contract-Counter.json (1.2MB test contract) SHIPS in npm tarball (not excluded by !target/*.json.bak) — unintended surface + bloat.
- Coverage gap: pay_fee/mint/mint_and_pay_fee have ZERO active Noir TXE tests (all commented BLOCKED); only private.test.ts integration covers them (needs live network); mint_and_pay_fee only in benchmark (no assertions).
