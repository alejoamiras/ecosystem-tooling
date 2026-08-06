// Prints the contract class id of a compiled Noir artifact JSON.
// Usage: bun scripts/class-id.ts target/quota_fpc-QuotaFpc.json
import { classIdOfArtifactJson } from './artifact-class-id.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: bun scripts/class-id.ts <artifact.json>');
  process.exit(2);
}
console.log(await classIdOfArtifactJson(path));
