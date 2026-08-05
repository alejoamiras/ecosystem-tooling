// Prints the contract class id of a compiled Noir artifact JSON.
// Usage: bun scripts/class-id.ts target/quota_fpc-QuotaFpc.json
import { readFileSync } from 'node:fs';
import { getContractClassFromArtifact } from '@aztec/aztec.js/contracts';
import { loadContractArtifact } from '@aztec/stdlib/abi';

const path = process.argv[2];
if (!path) {
  console.error('usage: bun scripts/class-id.ts <artifact.json>');
  process.exit(2);
}
const artifact = loadContractArtifact(JSON.parse(readFileSync(path, 'utf8')));
const contractClass = await getContractClassFromArtifact(artifact);
console.log(contractClass.id.toString());
