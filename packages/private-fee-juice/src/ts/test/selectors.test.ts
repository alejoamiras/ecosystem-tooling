import { FeeJuiceContractArtifact } from '@aztec/noir-contracts.js/FeeJuice';
import { FunctionSelector } from '@aztec/stdlib/abi';
import { describe, expect, it } from 'vitest';
import { PrivateFPCContractArtifact } from '../../artifacts/PrivateFPC.js';

/**
 * The fee-payment methods hand-encode call signatures as strings
 * (fee-payment-methods/private.ts, shared.ts) because they build FunctionCalls without
 * loading the target artifact at runtime. tsc cannot check a signature string against an
 * ABI, so an upstream (FeeJuice) or local (PrivateFPC) signature change would only surface
 * as a runtime selector mismatch. This test pins each hardcoded string to the ABI it
 * mirrors — plan aztec-5-stable phase 3.5 (audit finding F-9).
 */
const CASES: Array<{ artifact: typeof FeeJuiceContractArtifact; fn: string; signature: string }> = [
  { artifact: FeeJuiceContractArtifact, fn: 'claim', signature: 'claim((Field),u128,Field,Field)' },
  {
    artifact: PrivateFPCContractArtifact,
    fn: 'mint_and_pay_fee',
    signature: 'mint_and_pay_fee(u128,Field,Field)',
  },
  { artifact: PrivateFPCContractArtifact, fn: 'pay_fee', signature: 'pay_fee()' },
];

describe('hardcoded selector strings match the ABIs they mirror', () => {
  for (const { artifact, fn, signature } of CASES) {
    it(`${artifact.name}.${fn} == fromSignature('${signature}')`, async () => {
      const fnArtifact = artifact.functions.find((f) => f.name === fn);
      expect(fnArtifact, `${fn} missing from ${artifact.name} ABI`).toBeDefined();
      const fromAbi = await FunctionSelector.fromNameAndParameters(fnArtifact!.name, fnArtifact!.parameters);
      const fromString = await FunctionSelector.fromSignature(signature);
      expect(fromString.equals(fromAbi)).toBe(true);
    });
  }
});
