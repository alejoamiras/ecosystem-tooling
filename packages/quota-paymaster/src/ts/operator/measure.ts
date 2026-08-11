/**
 * Measures what sponsored transactions ACTUALLY cost on a live network.
 *
 * Exists because fees float and gas profiles must be budgeted from the real
 * ACTION, never the harness (the do-nothing target's cost is the machinery's
 * floor — a real action can be many times it). Re-run after fee moves or
 * gas-profile changes.
 *
 * The send pipeline is injected: building, proving, and sending a sponsored
 * transaction needs a wallet + client wiring that the caller (test harness,
 * CLI, app) already owns. This module owns the measurement discipline around
 * it: quota preflight, clamping, the inter-send PXE-lag wait, and honest
 * accounting from receipts + balance deltas.
 */
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';

export interface MeasureDeps {
  node: AztecNode;
  fpcAddress: AztecAddress;
  /**
   * Sends ONE sponsored transaction (i is 0-based) and resolves once it is
   * included, returning the receipt's transaction fee in wei.
   */
  sendSponsored: (i: number) => Promise<{ transactionFeeWei: bigint }>;
  /** Reads (hasAllowance, remaining) for the measuring player. */
  readQuotaInfo: () => Promise<{ hasAllowance: boolean; remaining: number }>;
  onProgress?: (msg: string) => void;
}

export interface MeasureResult {
  perTransactionWei: bigint[];
  totalFromReceiptsWei: bigint;
  /** Independent check: the paymaster's balance delta over the run. */
  balanceDeltaWei: bigint;
  requested: number;
  measured: number;
}

export async function measureSponsoredFee(
  deps: MeasureDeps,
  opts: { count: number; interSendPollMs?: number; interSendTimeoutMs?: number } = { count: 2 },
): Promise<MeasureResult> {
  const { getFeeJuiceBalance } = await import('@aztec/aztec.js/utils');
  // Preflight so re-running does not try to over-subscribe; clamp to what the
  // allowance actually permits rather than failing partway. Independent of the
  // balance read, so both go out together.
  const [beforeRaw, quota] = await Promise.all([getFeeJuiceBalance(deps.fpcAddress, deps.node), deps.readQuotaInfo()]);
  const before = BigInt(beforeRaw ?? 0n);
  const budget = quota.hasAllowance ? quota.remaining : 0;
  const count = Math.min(opts.count, budget);
  if (count < opts.count) {
    deps.onProgress?.(`allowance permits ${count}/${opts.count} sends — measuring what is available`);
  }

  const perTransactionWei: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const { transactionFeeWei } = await deps.sendSponsored(i);
    perTransactionWei.push(transactionFeeWei);
    deps.onProgress?.(`send ${i + 1}/${count}: ${transactionFeeWei} wei`);

    if (i + 1 < count) {
      // The just-written note is not immediately visible to the local PXE;
      // firing the next send too fast makes a HEALTHY paymaster report "No
      // sponsored transactions remaining" purely from outrunning sync.
      const deadline = Date.now() + (opts.interSendTimeoutMs ?? 60_000);
      const expected = quota.remaining - (i + 1);
      for (;;) {
        const now = await deps.readQuotaInfo();
        if (now.remaining <= expected || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, opts.interSendPollMs ?? 500));
      }
    }
  }

  const after = BigInt((await getFeeJuiceBalance(deps.fpcAddress, deps.node)) ?? 0n);
  return {
    perTransactionWei,
    totalFromReceiptsWei: perTransactionWei.reduce((a, b) => a + b, 0n),
    balanceDeltaWei: before - after,
    requested: opts.count,
    measured: count,
  };
}
