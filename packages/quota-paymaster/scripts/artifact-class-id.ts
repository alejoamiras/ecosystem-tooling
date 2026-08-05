/** Shared by the dev/verification scripts: artifact JSON → contract class id. */
import { readFileSync } from 'node:fs';
import { getContractClassFromArtifact } from '@aztec/aztec.js/contracts';
import { loadContractArtifact } from '@aztec/stdlib/abi';

export async function classIdOfArtifactJson(path: string | URL): Promise<string> {
  const artifact = loadContractArtifact(JSON.parse(readFileSync(path, 'utf8')));
  return (await getContractClassFromArtifact(artifact)).id.toString();
}

/** For already-loaded (codegen'd) ContractArtifact values. */
export async function classIdOfArtifact(artifact: unknown): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: the artifact type is version-loose across entrypoints
  return (await getContractClassFromArtifact(artifact as any)).id.toString();
}
