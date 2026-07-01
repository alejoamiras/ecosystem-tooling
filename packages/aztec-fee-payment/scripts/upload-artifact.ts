import { resolve as pathResolve } from 'node:path';
import { getArtifactRegistryBaseUrl, uploadArtifactFileToRegistry } from '../src/ts/artifactRegistry.js';

/**
 * Usage:
 *   AZTEC_ARTIFACT_REGISTRY_URL=https://devnet.aztec-registry.xyz/ tsx scripts/upload-artifact.ts target/private_contract-PrivateFPC.json
 *
 * Notes:
 * - The registry typically verifies the artifact's classId exists on the target network.
 */
async function main() {
  const artifactPathArg = process.argv[2] ?? 'target/private_contract-PrivateFPC.json';
  const artifactPath = pathResolve(process.cwd(), artifactPathArg);
  const registryBaseUrl = getArtifactRegistryBaseUrl();

  const resp = await uploadArtifactFileToRegistry({
    artifactPath,
    registryBaseUrl,
  });

  if (resp && typeof resp === 'object' && 'success' in resp && resp.success === false) {
    throw new Error(
      `Upload failed: ${'error' in resp ? String(resp.error ?? resp.message ?? 'unknown error') : 'unknown error'}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        registryBaseUrl,
        artifactPath,
        ...resp,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
