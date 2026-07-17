import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';
import { PublicKeys } from '@aztec/aztec.js/keys';

import { PrivateFPCContractArtifact } from '../src/artifacts/PrivateFPC.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
const AZTEC_VERSION = packageJson.dependencies?.['@aztec/aztec.js'] ?? packageJson.devDependencies?.['@aztec/aztec.js'];

if (!AZTEC_VERSION) {
  console.error('Error: Could not determine Aztec version from package.json.');
  process.exit(1);
}

async function computePrivateAddress(salt: Fr): Promise<AztecAddress> {
  const instance = await getContractInstanceFromInstantiationParams(PrivateFPCContractArtifact, {
    constructorArgs: [],
    salt,
    publicKeys: PublicKeys.default(),
    deployer: AztecAddress.ZERO,
  });
  return instance.address;
}

async function main() {
  const saltEnv = process.env.PRIVATE_FPC_SALT;
  if (!saltEnv) {
    console.error('Error: PRIVATE_FPC_SALT is required. Set it in your .env file.');
    process.exit(1);
  }
  const salt = Fr.fromString(saltEnv);
  const address = await computePrivateAddress(salt);

  console.log(`
========================================
  PrivateFPC
========================================
  Address:            ${address.toString()}
  Salt:               ${salt.toString()}
  Compiled with Aztec: ${AZTEC_VERSION}

  No deployment needed — fully private, deterministic address.

  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  !!              DANGER                !!
  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

  This address is ONLY valid for Aztec version ${AZTEC_VERSION}

  The address is derived from compiled bytecode. A different
  Aztec version produces different bytecode, which means a
  COMPLETELY DIFFERENT address. If you bridge funds to the
  wrong address, they are PERMANENTLY LOST. There is no
  recovery mechanism.

  BEFORE sending any funds, verify the target network version:
    curl -s -X POST <NODE_URL> -H 'Content-Type: application/json' \\
      -d '{"jsonrpc":"2.0","method":"node_getNodeInfo","id":1,"params":[]}' \\
      | jq .result.nodeVersion
  Expected: ${AZTEC_VERSION}
  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

  Next steps to start using the FPC:

  1. Register the contract in your app's PXE:
     const fpc = await registerPrivateContract(wallet, salt);

  2. Fund the FPC's public FeeJuice balance so it can
     pay sequencer fees. On L1, call:
     FeeJuicePortal.depositToAztecPublic(
       _to=<FPC address>, _amount, _secretHash
     )
     Then on L2: FeeJuice.claim(fpcAddress, amount, secret, leafIndex)

  3. Users bridge FJ and mint FJ for fee sponsorship.
     See the README or SDK docs for the full flow.
========================================
`);
}

main().catch((error) => {
  console.error('Failed:', error);
  process.exit(1);
});
