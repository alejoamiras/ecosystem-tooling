/**
 * `bridgeFeeJuice` against a REAL L1.
 *
 * The bridge is the only irreversible command in this package, and until now
 * it had no live coverage at all — only unit tests of the inputs it refuses.
 * That gap was invisible until round 22 rewrote the approval path (to sign
 * with the confirmed account rather than whatever the SDK's token manager
 * re-read at signing time) and the whole suite still passed, having exercised
 * none of it.
 *
 * What this proves: the approval and the deposit both land, the deposit is
 * signed by the account the plan named, and the journal records the secret
 * before L1 is touched and the confirmed deposit after.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { bridgeFeeJuice } from '../../operator/bridge.js';
import {
  BRIDGE_JOURNAL_FILE,
  closeJournalDir,
  openJournalDir,
  readJournalRecords,
} from '../../operator/internal/journal.js';
import { NODE_URL } from '../harness.js';

const L1_RPC_URL = process.env.L1_RPC_URL ?? 'http://127.0.0.1:8545';
// anvil's first well-known development key. Local networks only — this test
// does not run anywhere else.
const L1_KEY = process.env.L1_PRIVATE_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const cleanups: (() => void)[] = [];
afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe('bridgeFeeJuice (live L1)', () => {
  test('approves and deposits as the confirmed account, journaling around the L1 write', async () => {
    const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
    const { createEthereumChain } = await import('@aztec/ethereum/chain');
    const { createExtendedL1Client } = await import('@aztec/ethereum/client');

    const node = createAztecNodeClient(NODE_URL);
    const info = await node.getNodeInfo();
    const chain = createEthereumChain([L1_RPC_URL], info.l1ChainId);
    const l1Client = createExtendedL1Client(chain.rpcUrls, L1_KEY, chain.chainInfo);

    const dir = mkdtempSync(join(tmpdir(), 'quota-bridge-it-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const journal = openJournalDir(dir);
    cleanups.push(() => closeJournalDir(journal));

    const recipient = `0x0${'a'.repeat(63)}`;
    const amountWei = 1_000_000_000_000_000n;
    let planFrom: unknown;

    const result = await bridgeFeeJuice(
      {
        node,
        l1Client,
        journal,
        confirm: async (plan) => {
          planFrom = plan.details.from;
          return true;
        },
      },
      { to: recipient, amountWei },
    );

    // The plan named the signer, and the signer is who signed.
    expect(planFrom).toBe(l1Client.account.address.toLowerCase());
    expect(result.amountWei).toBe(amountWei);
    expect(result.messageHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(result.messageLeafIndex).toBeGreaterThan(0n);

    // The secret is durable BEFORE the money moves, and the deposit is
    // recorded after — the ordering the whole journal exists for.
    const { records, tornLines } = readJournalRecords(journal, BRIDGE_JOURNAL_FILE);
    expect(tornLines).toBe(0);
    const states = records.map((r) => r.state);
    expect(states).toContain('SECRET_GENERATED');
    expect(states).toContain('DEPOSIT_CONFIRMED');
    expect(states.indexOf('SECRET_GENERATED')).toBeLessThan(states.indexOf('DEPOSIT_CONFIRMED'));
  }, 300_000);
});
