/**
 * Stock config factories — the ~3-line common case for operators.
 *
 * KEY-ON-DISK REALITY (measured, not assumed — see the plan's Phase-1 lessons):
 * there is no zero-disk option. Creating a Schnorr account through the Aztec
 * wallet writes the account's secret AND signing key into an LMDB store, in
 * BOTH the "ephemeral" and durable modes. The wallet's ephemeral store is a
 * real directory under the OS temp dir whose auto-delete callback only runs on
 * the store's `delete()` — which nothing in the wallet calls, so `stop()`
 * leaves the keys behind.
 *
 * So this factory does not pretend: it OWNS the directory. By default it
 * creates a private 0700 directory itself, points the wallet at it, and removes
 * it in `dispose()`. Set QUOTA_WALLET_DIR to keep a durable store instead — the
 * directory is then held to the same ownership/mode bar the claim-secret
 * journal enforces, and is never deleted.
 *
 * Keys are read from the environment only. This factory NEVER generates keys
 * and never writes them to a project file. Error messages name the offending
 * FIELD, never its value.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperatorConfigError, type OperatorConfigFactory, type OperatorContext } from './config-module.js';

export interface SchnorrAccountFromEnvOptions {
  /** Defaults to process.env; injectable for tests. */
  env?: Record<string, string | undefined>;
}

const REQUIRED_KEY_VARS = ['ACCOUNT_SECRET_KEY', 'ACCOUNT_SALT', 'ACCOUNT_SIGNING_KEY'] as const;

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new OperatorConfigError('shape-invalid', `${name} is required but not set in the environment`);
  }
  return value;
}

/** Parses without ever putting the value in an error message. */
function parseField<T>(name: string, raw: string, parse: (raw: string) => T): T {
  try {
    return parse(raw);
  } catch {
    throw new OperatorConfigError(
      'shape-invalid',
      `${name} is not a valid ${name === 'ACCOUNT_SIGNING_KEY' ? 'Fq (hex scalar)' : 'Fr (field element)'}. ` +
        `Value withheld from this message on purpose.`,
    );
  }
}

/** Same ownership/mode bar journal.ts holds for claim secrets. */
function assertPrivateDir(dirPath: string): void {
  const st = statSync(dirPath);
  if (!st.isDirectory()) throw new OperatorConfigError('shape-invalid', `${dirPath} is not a directory`);
  if (process.getuid && st.uid !== process.getuid()) {
    throw new OperatorConfigError('shape-invalid', `wallet dir ${dirPath} is not owned by this user; refusing`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new OperatorConfigError(
      'shape-invalid',
      `wallet dir ${dirPath} is group/world accessible (mode ${(st.mode & 0o777).toString(8)}); ` +
        `chmod 700 it — it holds account keys`,
    );
  }
}

/**
 * Builds an OperatorContext from environment variables.
 *
 * Required: ACCOUNT_SECRET_KEY (Fr), ACCOUNT_SALT (Fr), ACCOUNT_SIGNING_KEY (Fq hex).
 * Optional: NODE_URL (default http://localhost:8080), ACCOUNT_ADDRESS (offline
 * cross-check — a mismatch throws before any network call), QUOTA_WALLET_DIR
 * (durable store opt-in), L1_RPC_URL + L1_PRIVATE_KEY (enables `bridge`).
 */
export function schnorrAccountFromEnv(options: SchnorrAccountFromEnvOptions = {}): OperatorConfigFactory {
  return async (): Promise<OperatorContext> => {
    const env = options.env ?? process.env;
    for (const name of REQUIRED_KEY_VARS) requireEnv(env, name);

    const [{ Fr, Fq }, { createAztecNodeClient, waitForNode }] = await Promise.all([
      import('@aztec/aztec.js/fields'),
      import('@aztec/aztec.js/node'),
    ]);

    let EmbeddedWallet: {
      create: (node: unknown, opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    try {
      ({ EmbeddedWallet } = (await import('@aztec/wallets/embedded')) as never);
    } catch (cause) {
      throw new OperatorConfigError(
        'loader-missing',
        'schnorrAccountFromEnv needs the optional "@aztec/wallets" peer dependency. ' +
          'Install @aztec/wallets@5.0.1, or write your own factory returning { node, wallet, from }.',
        { cause },
      );
    }

    const secretKey = parseField('ACCOUNT_SECRET_KEY', requireEnv(env, 'ACCOUNT_SECRET_KEY'), (r) => Fr.fromString(r));
    const salt = parseField('ACCOUNT_SALT', requireEnv(env, 'ACCOUNT_SALT'), (r) => Fr.fromString(r));
    const signingKey = parseField('ACCOUNT_SIGNING_KEY', requireEnv(env, 'ACCOUNT_SIGNING_KEY'), (r) =>
      Fq.fromString(r.startsWith('0x') ? r : `0x${r}`),
    );

    // Offline cross-check BEFORE any network call: catches a swapped or
    // corrupted env before it can act on a chain.
    const expectedAddress = env.ACCOUNT_ADDRESS?.trim();
    if (expectedAddress) {
      const { getSchnorrInitializerlessAccountContractAddress } = await import('@aztec/accounts/schnorr');
      const derived = await getSchnorrInitializerlessAccountContractAddress(signingKey, salt, secretKey);
      if (derived.toString().toLowerCase() !== expectedAddress.toLowerCase()) {
        throw new OperatorConfigError(
          'shape-invalid',
          `ACCOUNT_ADDRESS does not match the address derived from the configured keys ` +
            `(derived ${derived.toString()}). Refusing before touching the network.`,
        );
      }
    }

    // The key store's directory is OURS, so its lifetime is knowable.
    const durableDir = env.QUOTA_WALLET_DIR?.trim();
    let walletDir: string;
    let deleteOnDispose: boolean;
    if (durableDir) {
      mkdirSync(durableDir, { recursive: true, mode: 0o700 });
      assertPrivateDir(durableDir);
      walletDir = durableDir;
      deleteOnDispose = false;
    } else {
      walletDir = mkdtempSync(join(tmpdir(), 'quota-operator-wallet-'));
      assertPrivateDir(walletDir);
      deleteOnDispose = true;
    }

    const nodeUrl = env.NODE_URL?.trim() || 'http://localhost:8080';
    const node = createAztecNodeClient(nodeUrl);
    await waitForNode(node);

    const wallet = await EmbeddedWallet.create(node, { dataDirectory: walletDir });
    const account = (await (
      wallet as unknown as {
        createSchnorrInitializerlessAccount: (s: unknown, sa: unknown, sk: unknown) => Promise<{ address: unknown }>;
      }
    ).createSchnorrInitializerlessAccount(secretKey, salt, signingKey)) as { address: { toString(): string } };

    const l1RpcUrl = env.L1_RPC_URL?.trim();
    const l1PrivateKey = env.L1_PRIVATE_KEY?.trim();
    let l1: OperatorContext['l1'];
    if (l1RpcUrl && l1PrivateKey) {
      // Same construction the repo-local CLI already uses for bridging.
      const [info, { createEthereumChain }, { createExtendedL1Client }] = await Promise.all([
        node.getNodeInfo(),
        import('@aztec/ethereum/chain'),
        import('@aztec/ethereum/client'),
      ]);
      const chain = createEthereumChain([l1RpcUrl], info.l1ChainId);
      l1 = { client: createExtendedL1Client(chain.rpcUrls, l1PrivateKey, chain.chainInfo) as never };
    }

    return {
      node: node as never,
      wallet: wallet as never,
      from: account.address as never,
      l1,
      dispose: async () => {
        try {
          await (wallet as unknown as { stop: () => Promise<void> }).stop();
        } finally {
          if (deleteOnDispose) rmSync(walletDir, { recursive: true, force: true, maxRetries: 3 });
        }
      },
    };
  };
}
