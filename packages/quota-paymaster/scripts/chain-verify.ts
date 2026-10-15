// READ-ONLY check that a deployed QuotaFpc instance is the class this package pins: one
// node_getContract query, no keys, no transactions. Fail-closed: exits 1 unless the
// instance's current AND original class ids both equal the compiled artifact's and the
// known-deployments.json anchor for currentAztecVersion. Record a pass by hand.
// Usage: bun scripts/chain-verify.ts <address> [nodeUrl]   (nodeUrl default: $NODE_URL)
import { readFileSync } from 'node:fs';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { type KnownDeployments, selectAnchor } from '../src/ts/operator/lineage.js';
import { classIdOfArtifactJson } from './artifact-class-id.js';

const [address, nodeArg] = process.argv.slice(2);
const nodeUrl = nodeArg ?? process.env.NODE_URL;
if (!address || !AztecAddress.isAddress(address) || !nodeUrl) {
  console.error('usage: bun scripts/chain-verify.ts <address> [nodeUrl]   (nodeUrl defaults to $NODE_URL)');
  process.exit(2);
}

const known: KnownDeployments = JSON.parse(readFileSync(new URL('../known-deployments.json', import.meta.url), 'utf8'));
const anchor = selectAnchor(known, known.currentAztecVersion);
const localClassId = await classIdOfArtifactJson(new URL('../target/quota_fpc-QuotaFpc.json', import.meta.url));
console.log(`anchor classId (Aztec ${anchor.aztecVersion}): ${anchor.classId}`);
console.log(`local  classId: ${localClassId}`);

const instance = await createAztecNodeClient(nodeUrl).getContract(AztecAddress.fromStringUnsafe(address));
if (!instance) {
  console.error(`FAIL-CLOSED: node at ${nodeUrl} returned no contract at ${address}`);
  process.exit(1);
}
const chainCurrent = instance.currentContractClassId.toString();
const chainOriginal = instance.originalContractClassId.toString();
console.log(`chain  currentContractClassId:  ${chainCurrent}`);
console.log(`chain  originalContractClassId: ${chainOriginal}`);

const mismatches = [
  localClassId !== anchor.classId && 'the compiled artifact is not the anchored class (run verify:lineage)',
  chainCurrent !== anchor.classId && 'currentContractClassId is not the anchored class',
  chainOriginal !== anchor.classId && 'originalContractClassId is not the anchored class',
].filter(Boolean);
if (mismatches.length > 0) {
  for (const m of mismatches) console.error(`HARD STOP: ${m}`);
  process.exit(1);
}
console.log(`MATCH: ${address} on ${nodeUrl} is the anchored class (current and original).`);
