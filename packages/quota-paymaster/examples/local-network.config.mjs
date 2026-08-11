/**
 * A config module for LOCAL NETWORKS — the pre-registered test accounts, no
 * key material anywhere.
 *
 *   bun scripts/cli.ts policy --fpc 0x… --config-module ./examples/local-network.config.mjs --show
 *
 * For a real network use schnorrAccountFromEnv() instead (see the README): it
 * reads ACCOUNT_SECRET_KEY / ACCOUNT_SALT / ACCOUNT_SIGNING_KEY from the
 * environment, never from argv, and never generates or persists keys.
 */
import { defineOperatorConfig } from '../src/ts/operator/config.js';

export default defineOperatorConfig(async () => {
  const { createAztecNodeClient, waitForNode } = await import('@aztec/aztec.js/node');
  const { EmbeddedWallet } = await import('@aztec/wallets/embedded');
  const { registerInitialLocalNetworkAccountsInWallet } = await import('@aztec/wallets/testing');

  const node = createAztecNodeClient(process.env.NODE_URL ?? 'http://localhost:8080');
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
  const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);
  if (accounts.length === 0) throw new Error('no pre-registered accounts on this network');

  return { node, wallet, from: accounts[0], dispose: () => wallet.stop() };
});
