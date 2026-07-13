import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';
import { PublicKeys } from '@aztec/aztec.js/keys';
import { describe, expect, it } from 'vitest';
import { PrivateFPCContractArtifact } from '../../artifacts/PrivateFPC.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * canonical-deployment.json is the single source of truth for the published PrivateFPC
 * address (README embeds it; funds bridged to a stale address are unrecoverable). A hand
 * transcription can pass every other gate, so this asserts the committed address against
 * the same derivation `bun run compute` uses, from the actual compiled artifact.
 */
describe('canonical-deployment.json matches the compiled artifact', () => {
  const canonical = JSON.parse(readFileSync(join(__dirname, '../../../canonical-deployment.json'), 'utf8'));

  it('aztecVersion matches the package pin', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));
    const pinned = pkg.peerDependencies?.['@aztec/aztec.js'] ?? pkg.devDependencies?.['@aztec/aztec.js'];
    expect(canonical.aztecVersion).toBe(pinned);
  });

  it('expectedAddress derives from the artifact + canonical salt', async () => {
    const instance = await getContractInstanceFromInstantiationParams(PrivateFPCContractArtifact, {
      constructorArgs: [],
      salt: Fr.fromString(canonical.salt),
      publicKeys: PublicKeys.default(),
      deployer: AztecAddress.ZERO,
    });
    expect(instance.address.toString()).toBe(canonical.expectedAddress);
  });
});
