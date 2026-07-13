import 'dotenv/config';

import { deriveSecretKeyFromSigningKey } from '@aztec/accounts/utils';
import type { AztecAddressLike, ContractArtifact, FieldLike } from '@aztec/aztec.js/abi';
import { NO_FROM } from '@aztec/aztec.js/account';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import {
  Contract,
  type DeployOptions,
  getContractInstanceFromInstantiationParams,
  type InteractionFeeOptions,
} from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fq, Fr } from '@aztec/aztec.js/fields';
import { PublicKeys } from '@aztec/aztec.js/keys';
import { type AztecNode, createAztecNodeClient } from '@aztec/aztec.js/node';
import { TxStatus } from '@aztec/aztec.js/tx';
import type { AccountManager, Wallet } from '@aztec/aztec.js/wallet';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { createLogger } from '@aztec/foundation/log';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { Command, Option } from 'commander';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DripperContract, DripperContractArtifact } from '../src/artifacts/Dripper.js';
import { TokenContract, TokenContractArtifact } from '../src/artifacts/Token.js';
import { type DeploymentConfig, getConfig, type Network } from './deploy-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let packageJson: Record<string, unknown>;
try {
  packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
} catch (error) {
  throw new Error('Failed to read package.json: ensure the file exists and is valid JSON');
}

const logger = createLogger('aztec:deploy');

// --- Types ---

export interface DeployedContracts {
  tokens: Record<string, { contract: TokenContract; status: 'deployed' | 'existing' }>;
  dripper?: { contract: DripperContract; status: 'deployed' | 'existing' };
}

interface TokenConstructorArgs {
  name: string;
  symbol: string;
  decimals: number;
  minter: AztecAddress;
}

interface DeploymentToken {
  address: AztecAddress;
  salt: FieldLike;
  deployer: AztecAddress;
  constructorArtifact: string;
  constructorArgs: TokenConstructorArgs;
}

interface DeploymentDripper {
  address: AztecAddressLike;
  salt: FieldLike;
  deployer: AztecAddressLike;
  constructorArtifact: string;
}

export interface DeploymentData {
  tokens: DeploymentToken[];
  dripper?: DeploymentDripper;
}

interface DeployedContract<T> {
  contract: T;
  status: 'deployed' | 'existing';
}

export interface DeployResult {
  contracts: DeployedContracts;
}

const UNIVERSAL_DEPLOYER = AztecAddress.ZERO;

function getDeploymentData(
  tokenAddresses: Record<string, AztecAddress>,
  dripperAddress: AztecAddress | undefined,
  config: DeploymentConfig,
): DeploymentData {
  const minterAddress = dripperAddress || AztecAddress.ZERO;

  const tokens: DeploymentToken[] = Object.entries(config.contracts.tokens)
    .filter(([key]) => key in tokenAddresses)
    .map(([key, tokenConfig]) => ({
      address: tokenAddresses[key],
      salt: tokenConfig.salt,
      deployer: UNIVERSAL_DEPLOYER,
      constructorArtifact: 'constructor_with_minter' as const,
      constructorArgs: {
        name: tokenConfig.name,
        symbol: tokenConfig.symbol,
        decimals: tokenConfig.decimals,
        minter: minterAddress,
      },
    }));

  const result: DeploymentData = { tokens };

  if (dripperAddress) {
    result.dripper = {
      address: dripperAddress,
      salt: config.contracts.dripper.salt,
      deployer: UNIVERSAL_DEPLOYER,
      constructorArtifact: 'constructor',
    };
  }

  return result;
}

// --- CLI ---

interface CLIOptions {
  dryRun?: boolean;
  output?: string;
  writeDeployments?: boolean;
  network: Network;
}

export function logDeployedContracts(contracts: DeployedContracts): void {
  logger.info('Deployed contracts:');

  for (const [key, value] of Object.entries(contracts.tokens)) {
    const status = value.status === 'deployed' ? '[NEWLY DEPLOYED]' : '[EXISTING]';
    logger.info(`${key}: ${value.contract.address.toString()} ${status}`);
  }

  if (contracts.dripper) {
    const status = contracts.dripper.status === 'deployed' ? '[NEWLY DEPLOYED]' : '[EXISTING]';
    logger.info(`dripper: ${contracts.dripper.contract.address.toString()} ${status}`);
  }
}

export interface TokenDeployParams {
  name: string;
  symbol: string;
  decimals: number;
  minter?: AztecAddress;
  salt: Fr;
}

export async function createSponsoredFeeOptions(wallet: Wallet): Promise<InteractionFeeOptions> {
  logger.info('Setting up sponsored fee options...');

  const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });

  try {
    await wallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
    logger.info(`Registered SponsoredFPC at: ${sponsoredFPCInstance.address.toString()}`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('already')) {
      logger.debug('SponsoredFPC already registered');
    } else {
      throw error;
    }
  }

  const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);

  return {
    paymentMethod,
  };
}

/**
 * Deploys the account contract on-chain if not already deployed.
 * Handles the case where the account was already deployed (existing nullifier error).
 */
async function deployAccount(
  manager: AccountManager,
  node: AztecNode,
  feeOptions: InteractionFeeOptions,
): Promise<void> {
  const address = manager.getInstance().address;

  const existing = await node.getContract(address);
  if (existing) {
    logger.info(`Account contract already deployed at ${address.toString()}`);
    return;
  }

  logger.info(`Deploying account contract at ${address.toString()}...`);
  try {
    const deployMethod = await manager.getDeployMethod();
    // 5.0.0: self-paid account deploys use the NO_FROM sentinel (AztecAddress.ZERO now
    // fails with "Account 0x00…00 does not exist on this wallet").
    const result = await deployMethod.send({ fee: feeOptions, from: NO_FROM });
    logger.info(`Account contract deployed at ${result.contract.address.toString()}`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('Existing nullifier')) {
      logger.info('Account contract already deployed (nullifier exists)');
    } else {
      throw error;
    }
  }
}

async function checkContractDeployed(node: AztecNode, address: AztecAddress): Promise<boolean> {
  try {
    logger.info(`Checking if contract deployed at ${address.toString()}...`);
    const instance = await node.getContract(address);
    if (!instance) {
      logger.info(`Contract at ${address.toString()} instance not found`);
      return false;
    }
    logger.info(`Contract instance found at ${address.toString()}`);
    return true;
  } catch (error) {
    logger.info(`Contract at ${address.toString()} not found or not initialized: ${error}`);
    return false;
  }
}

async function deployContract(
  deployer: Wallet,
  node: AztecNode,
  artifact: ContractArtifact,
  constructorArgs: unknown[],
  constructorArtifact: string,
  salt: Fr,
  options: DeployOptions,
  label: string,
): Promise<{ address: AztecAddress; status: 'deployed' | 'existing' }> {
  logger.info(`Checking ${label}...`);

  const instance = await getContractInstanceFromInstantiationParams(artifact, {
    constructorArgs,
    salt,
    publicKeys: PublicKeys.default(),
    deployer: AztecAddress.ZERO,
    constructorArtifact,
  });

  const isDeployed = await checkContractDeployed(node, instance.address);

  if (isDeployed) {
    logger.info(`${label} already deployed at: ${instance.address.toString()}`);

    try {
      await deployer.registerContract(instance, artifact);
      logger.debug(`${label} registered with PXE`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('already')) {
        logger.debug(`${label} already registered with PXE`);
      } else {
        throw error;
      }
    }

    return { address: instance.address, status: 'existing' };
  }

  logger.info(`Deploying ${label}...`);

  const deployMethod = Contract.deploy(deployer, artifact, constructorArgs, constructorArtifact, {
    salt,
    universalDeploy: true,
  });

  try {
    await deployMethod.send({
      ...options,
      wait: { waitForStatus: TxStatus.PROPOSED },
    });
  } catch (error: unknown) {
    const msg =
      error instanceof Error
        ? error.message
        : error instanceof Object && 'cause' in error && error.cause instanceof Error
          ? error.cause.message
          : String(error);
    if (msg.includes('Existing nullifier')) {
      logger.info(`${label} already deployed (existing nullifier) at: ${instance.address.toString()}`);
      return { address: instance.address, status: 'existing' };
    }
    throw error;
  }

  logger.info(`${label} deployed at: ${instance.address.toString()}`);
  return { address: instance.address, status: 'deployed' };
}

export async function deployToken(
  deployer: Wallet,
  node: AztecNode,
  params: TokenDeployParams,
  options: DeployOptions,
): Promise<{ contract: TokenContract; status: 'deployed' | 'existing' }> {
  const minter = params.minter || AztecAddress.ZERO;

  const result = await deployContract(
    deployer,
    node,
    TokenContractArtifact,
    [params.name, params.symbol, params.decimals, minter],
    'constructor_with_minter',
    params.salt,
    options,
    `Token ${params.name} (${params.symbol})`,
  );

  const contract = await TokenContract.at(result.address, deployer);
  return { contract, status: result.status };
}

export async function deployDripper(
  deployer: Wallet,
  node: AztecNode,
  salt: Fr,
  options: DeployOptions,
): Promise<{ contract: DripperContract; status: 'deployed' | 'existing' }> {
  const result = await deployContract(
    deployer,
    node,
    DripperContractArtifact,
    [],
    'constructor',
    salt,
    options,
    'Dripper',
  );

  const contract = await DripperContract.at(result.address, deployer);
  return { contract, status: result.status };
}

interface ComputedAddresses {
  tokens: Record<string, AztecAddress>;
  dripper: AztecAddress;
}

async function computeContractAddresses(config: DeploymentConfig): Promise<ComputedAddresses> {
  let dripper: AztecAddress;
  if (config.contracts.dripper.existingAddress) {
    dripper = config.contracts.dripper.existingAddress;
  } else {
    const dripperInstance = await getContractInstanceFromInstantiationParams(DripperContractArtifact, {
      constructorArgs: [],
      salt: new Fr(config.contracts.dripper.salt),
      publicKeys: PublicKeys.default(),
      deployer: AztecAddress.ZERO,
    });
    dripper = dripperInstance.address;
  }

  const tokens: Record<string, AztecAddress> = {};
  for (const [key, tokenConfig] of Object.entries(config.contracts.tokens)) {
    const instance = await getContractInstanceFromInstantiationParams(TokenContractArtifact, {
      constructorArgs: [tokenConfig.name, tokenConfig.symbol, tokenConfig.decimals, dripper],
      salt: new Fr(tokenConfig.salt),
      publicKeys: PublicKeys.default(),
      deployer: AztecAddress.ZERO,
      constructorArtifact: 'constructor_with_minter',
    });
    tokens[key] = instance.address;
  }

  return { tokens, dripper };
}

export async function deployContracts(options: CLIOptions, config: DeploymentConfig): Promise<DeployResult> {
  logger.info(`Deploying to ${config.network.name}...`);
  logger.info(`Network: ${config.network.nodeUrl}`);

  if (options.dryRun) {
    logger.info('[DRY RUN] Computing contract addresses...');
    const addresses = await computeContractAddresses(config);
    const deploymentData = getDeploymentData(addresses.tokens, addresses.dripper, config);

    logger.info('[DRY RUN] Deployment data:');
    logger.info(JSON.stringify(deploymentData, null, 4));

    if (options.output) {
      const jsonOutput = JSON.stringify(deploymentData, null, 4);
      mkdirSync(dirname(options.output), { recursive: true });
      writeFileSync(options.output, jsonOutput);
      logger.info(`[DRY RUN] Deployment data written to ${options.output}`);
    }

    return { contracts: { tokens: {} } };
  }

  const nodeUrl = config.network.nodeUrl;

  // Dev utility (not published): at 5.0.0 the signing key is the account's ownership root.
  // Env-only (never argv — shell history), strict when provided, random for throwaway runs.
  const signingKeyHex = process.env.DEPLOYER_SIGNING_KEY;
  let signingKey: Fq;
  if (signingKeyHex && signingKeyHex.trim().length > 0) {
    const v = BigInt(signingKeyHex.trim());
    if (v <= 0n || v >= Fq.MODULUS) {
      throw new Error('DEPLOYER_SIGNING_KEY must be a hex scalar in (0, Fq.MODULUS) — no reduction applied');
    }
    signingKey = new Fq(v);
  } else {
    signingKey = Fq.random();
    logger.warn(
      'DEPLOYER_SIGNING_KEY not set — using a RANDOM signing key (throwaway account, address not reproducible)',
    );
  }
  const deployerSecret = await deriveSecretKeyFromSigningKey(signingKey);

  const node = createAztecNodeClient(nodeUrl);
  const isLocalNetwork = config.network.name === 'local-network';
  const wallet = await EmbeddedWallet.create(nodeUrl, {
    pxe: {
      proverEnabled: !isLocalNetwork,
      // 5.0.0 resets PXE stores on schema change; DEPLOYER_DATA_DIR lets test runs
      // use a scratch dir instead of the configured persistent one (run isolation).
      dataDirectory: process.env.DEPLOYER_DATA_DIR ?? config.deployer.dataDirectory,
      dataStoreMapSizeKb: 1e6,
    },
  });
  logger.info('Connected to PXE');

  try {
    const nodeInfo = await node.getNodeInfo();
    logger.info(`Connected to Aztec node version: ${nodeInfo.nodeVersion}`);

    const manager = await wallet.createSchnorrAccount(deployerSecret, Fr.ZERO, signingKey);
    const account = await manager.getAccount();
    logger.info(`Account created: ${account.getAddress().toString()}`);

    const sponsoredFeeOptions = await createSponsoredFeeOptions(wallet);
    await deployAccount(manager, node, sponsoredFeeOptions);

    const deployOptions: DeployOptions = {
      from: account.getAddress(),
      fee: sponsoredFeeOptions,
    };

    logger.info(`Deploying with account: ${account.getAddress().toString()}`);

    const computedAddresses = await computeContractAddresses(config);
    logger.info('\n=== Computed Contract Addresses ===');
    logger.info(`Dripper: ${computedAddresses.dripper.toString()}`);
    for (const [key, addr] of Object.entries(computedAddresses.tokens)) {
      logger.info(`${key.toUpperCase()}: ${addr.toString()}`);
    }
    logger.info('===================================\n');

    let dripper: { contract: DripperContract; status: 'deployed' | 'existing' } | undefined;

    if (config.contracts.dripper.existingAddress) {
      logger.info(`Using existing dripper at ${config.contracts.dripper.existingAddress}`);
      const dripperAddress = config.contracts.dripper.existingAddress;

      const dripperInstance = await node.getContract(dripperAddress);
      if (!dripperInstance) throw new Error('Dripper not found');

      logger.info(`Dripper found at: ${dripperAddress.toString()}`);

      try {
        await wallet.registerContract(dripperInstance, DripperContractArtifact);
        logger.debug('Dripper registered with PXE');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('already')) {
          logger.debug('Dripper already registered');
        } else {
          throw error;
        }
      }

      const dripperContract = await DripperContract.at(dripperAddress, wallet);
      dripper = { contract: dripperContract, status: 'existing' };
    } else {
      logger.info('Deploying or checking dripper contract...');
      const dripperSalt = new Fr(config.contracts.dripper.salt);
      dripper = await deployDripper(wallet, node, dripperSalt, deployOptions);
    }

    if (!dripper) {
      throw new Error('Dripper deployment failed');
    }

    logger.info('Deploying/checking token contracts...');

    const tokenEntries = Object.entries(config.contracts.tokens);
    const deployedTokens: Record<string, DeployedContract<TokenContract>> = {};

    for (const [key, tokenConfig] of tokenEntries) {
      const result = await deployToken(
        wallet,
        node,
        {
          name: tokenConfig.name,
          symbol: tokenConfig.symbol,
          decimals: tokenConfig.decimals,
          minter: dripper.contract.address,
          salt: new Fr(tokenConfig.salt),
        },
        deployOptions,
      );

      deployedTokens[key] = result;
    }

    // Post-deploy verification
    const postDeployInfo = await node.getNodeInfo();
    logger.info(`Post-deploy verification: node ${postDeployInfo.nodeVersion} responsive`);

    logger.info('Deployment completed successfully!');

    const deployedContracts: DeployedContracts = {
      tokens: deployedTokens,
      dripper,
    };

    return { contracts: deployedContracts };
  } finally {
    await wallet.stop();
  }
}

const program = new Command();

program
  .name('deploy')
  .description('Deploy Aztec Standards contracts')
  .version(String(packageJson.version))
  .option('--write-deployments', 'Update src/deployments.json with the deployed addresses (off by default)')
  .option('--dry-run', 'Show configuration without deploying')
  .option('--output <file>', 'Write deployment JSON to file')
  .addOption(
    new Option('-n, --network <network>', 'Target network')
      .choices(['devnet', 'testnet', 'local-network'])
      .default('devnet'),
  )
  .action(async (options: CLIOptions) => {
    try {
      const activeConfig = getConfig(options.network);

      const result = await deployContracts(options, activeConfig);
      logDeployedContracts(result.contracts);

      if (!options.dryRun && options.writeDeployments) {
        const tokenAddresses = Object.fromEntries(
          Object.entries(result.contracts.tokens).map(([k, v]) => [k, v.contract.address]),
        );
        const dripperAddress = result.contracts.dripper?.contract?.address;
        const deploymentData = getDeploymentData(tokenAddresses, dripperAddress, activeConfig);

        // Always update src/deployments.json
        const deploymentsPath = join(__dirname, '../src/deployments.json');
        writeFileSync(deploymentsPath, JSON.stringify(deploymentData, null, 4) + '\n');
        logger.info(`Updated ${deploymentsPath}`);

        if (options.output) {
          const jsonOutput = JSON.stringify(deploymentData, null, 4);
          mkdirSync(dirname(options.output), { recursive: true });
          writeFileSync(options.output, jsonOutput);
          logger.info(`Deployment data written to ${options.output}`);
        }
      }
    } catch (error) {
      logger.error('Deployment failed:', error);
      process.exitCode = 1;
    }
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  program.parseAsync(process.argv).then(() => process.exit(process.exitCode ?? 0));
}
