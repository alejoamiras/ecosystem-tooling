// ONE-TIME, READ-ONLY verification that the compiled QuotaFpc class id matches the
// live Aztec mainnet deployment (plan D2.1, fail-closed). No keys, no transactions —
// a single node_getContract query. Result is recorded in known-deployments.json.
// Usage: bun scripts/chain-verify.ts [nodeUrl]
import { readFileSync } from 'node:fs';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractClassFromArtifact } from '@aztec/aztec.js/contracts';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { loadContractArtifact } from '@aztec/stdlib/abi';

const MAINNET_INSTANCE = '0x0572042f6b9a6e6d33077a15c203ca81006ae162eab322efe32eeaffff5729d4';
const nodeUrl = process.argv[2] ?? process.env.MAINNET_NODE_URL ?? 'https://aztec-mainnet.drpc.org';

const artifact = loadContractArtifact(
  JSON.parse(readFileSync(new URL('../target/quota_fpc-QuotaFpc.json', import.meta.url), 'utf8')),
);
const localClassId = (await getContractClassFromArtifact(artifact)).id.toString();
console.log(`local  classId: ${localClassId}`);

const node = createAztecNodeClient(nodeUrl);
const instance = await node.getContract(AztecAddress.fromStringUnsafe(MAINNET_INSTANCE));
if (!instance) {
  console.error(`FAIL-CLOSED: node at ${nodeUrl} returned no contract at ${MAINNET_INSTANCE}`);
  process.exit(1);
}
const chainCurrent = instance.currentContractClassId.toString();
const chainOriginal = instance.originalContractClassId.toString();
console.log(`chain  currentContractClassId:  ${chainCurrent}`);
console.log(`chain  originalContractClassId: ${chainOriginal}`);

if (chainCurrent !== localClassId) {
  console.error('HARD STOP: compiled class id does NOT match the live mainnet instance.');
  process.exit(1);
}
console.log('MATCH: compiled artifact is the live mainnet class.');
