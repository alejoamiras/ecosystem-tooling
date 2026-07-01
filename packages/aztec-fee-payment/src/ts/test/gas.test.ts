import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { Gas, GasFees } from '@aztec/stdlib/gas';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FEE_MULTIPLIER,
  estimateGasSettings,
  maxFeesPerGasFromBaseFees,
  maxPriorityFeesPerGasFromMaxFees,
} from '../utils/gas.js';

describe('gas utilities', () => {
  it('scales base fees by the default 6/5 multiplier with ceiling', () => {
    const fees = maxFeesPerGasFromBaseFees({
      feePerDaGas: 5n,
      feePerL2Gas: 6n,
    });

    expect(fees.feePerDaGas).toBe(6n);
    expect(fees.feePerL2Gas).toBe(8n);
    expect(DEFAULT_FEE_MULTIPLIER).toEqual({ numerator: 6n, denominator: 5n });
  });

  it('accepts explicit numeric multipliers for non-default cases', () => {
    const fees = maxFeesPerGasFromBaseFees(
      {
        feePerDaGas: 10n,
        feePerL2Gas: 20n,
      },
      1.5,
    );

    expect(fees.feePerDaGas).toBe(15n);
    expect(fees.feePerL2Gas).toBe(30n);
  });

  it('mirrors max fees into priority fees', () => {
    const maxFees = new GasFees(11n, 13n);
    const priorityFees = maxPriorityFeesPerGasFromMaxFees(maxFees);

    expect(priorityFees).not.toBe(maxFees);
    expect(priorityFees.feePerDaGas).toBe(11n);
    expect(priorityFees.feePerL2Gas).toBe(13n);
  });

  it('pads simulated gas usage into limits and combines with fee caps', async () => {
    const from = await AztecAddress.random();
    const paymentMethod = {
      getAsset: vi.fn(),
      getFeePayer: vi.fn(),
      getExecutionPayload: vi.fn(),
      getGasSettings: vi.fn(),
    };
    // Raw gas consumed by the simulation (the new `gasUsed` metadata field).
    const totalGas = Gas.from({ daGas: 100, l2Gas: 200 });
    const teardownGas = Gas.from({ daGas: 10, l2Gas: 20 });
    const interaction = {
      simulate: vi.fn().mockResolvedValue({
        gasUsed: { totalGas, teardownGas },
      }),
    };
    // Network admission limit set high enough that padding never clamps.
    const aztecNode = {
      getCurrentMinFees: vi.fn().mockResolvedValue(new GasFees(10n, 20n)),
      getNodeInfo: vi.fn().mockResolvedValue({
        txsLimits: { gas: { daGas: 1_000_000, l2Gas: 2_000_000 } },
      }),
    };

    const gasSettings = await estimateGasSettings(interaction, {
      aztecNode,
      from,
      paymentMethod,
      additionalScopes: [await AztecAddress.random()],
    });

    expect(aztecNode.getCurrentMinFees).toHaveBeenCalledOnce();
    expect(aztecNode.getNodeInfo).toHaveBeenCalledOnce();
    expect(interaction.simulate).toHaveBeenCalledOnce();
    expect(interaction.simulate).toHaveBeenCalledWith({
      from,
      additionalScopes: expect.any(Array),
      includeMetadata: true,
      fee: {
        paymentMethod,
        gasSettings: {
          gasLimits: expect.any(Gas),
          teardownGasLimits: expect.any(Gas),
          maxFeesPerGas: expect.objectContaining({
            feePerDaGas: 12n,
            feePerL2Gas: 24n,
          }),
          maxPriorityFeesPerGas: expect.objectContaining({
            feePerDaGas: 12n,
            feePerL2Gas: 24n,
          }),
        },
      },
    });

    // gasLimits is the padded total gas; teardownGasLimits the padded teardown.
    const expectedGasLimits = totalGas.mul(1 + 0.1);
    const expectedTeardownGasLimits = teardownGas.mul(1 + 0.1);
    expect(gasSettings.gasLimits.daGas).toBe(expectedGasLimits.daGas);
    expect(gasSettings.gasLimits.l2Gas).toBe(expectedGasLimits.l2Gas);
    expect(gasSettings.teardownGasLimits.daGas).toBe(expectedTeardownGasLimits.daGas);
    expect(gasSettings.teardownGasLimits.l2Gas).toBe(expectedTeardownGasLimits.l2Gas);
    expect(gasSettings.maxFeesPerGas.feePerDaGas).toBe(12n);
    expect(gasSettings.maxFeesPerGas.feePerL2Gas).toBe(24n);
    expect(gasSettings.maxPriorityFeesPerGas.feePerDaGas).toBe(12n);
    expect(gasSettings.maxPriorityFeesPerGas.feePerL2Gas).toBe(24n);
  });

  it('clamps padded gas limits to the network admission limit', async () => {
    const from = await AztecAddress.random();
    const totalGas = Gas.from({ daGas: 100, l2Gas: 200 });
    const teardownGas = Gas.from({ daGas: 10, l2Gas: 20 });
    const interaction = {
      simulate: vi.fn().mockResolvedValue({
        gasUsed: { totalGas, teardownGas },
      }),
    };
    // Admission limit sits between the raw usage and its padded value, so the
    // padded limits are capped at the admission limit per dimension.
    const aztecNode = {
      getCurrentMinFees: vi.fn().mockResolvedValue(new GasFees(10n, 20n)),
      getNodeInfo: vi.fn().mockResolvedValue({
        txsLimits: { gas: { daGas: 105, l2Gas: 205 } },
      }),
    };

    const gasSettings = await estimateGasSettings(interaction, {
      aztecNode,
      from,
    });

    expect(gasSettings.gasLimits.daGas).toBe(105);
    expect(gasSettings.gasLimits.l2Gas).toBe(205);
  });

  it('throws when simulated usage exceeds the network admission limit', async () => {
    const from = await AztecAddress.random();
    const totalGas = Gas.from({ daGas: 100, l2Gas: 200 });
    const teardownGas = Gas.from({ daGas: 10, l2Gas: 20 });
    const interaction = {
      simulate: vi.fn().mockResolvedValue({
        gasUsed: { totalGas, teardownGas },
      }),
    };
    const aztecNode = {
      getCurrentMinFees: vi.fn().mockResolvedValue(new GasFees(10n, 20n)),
      getNodeInfo: vi.fn().mockResolvedValue({
        txsLimits: { gas: { daGas: 50, l2Gas: 2_000_000 } },
      }),
    };

    await expect(estimateGasSettings(interaction, { aztecNode, from })).rejects.toThrow(/consumes more gas/);
  });

  it('rejects non-finite or negative gas padding before simulating', async () => {
    const from = await AztecAddress.random();
    const interaction = { simulate: vi.fn() };
    const aztecNode = {
      getCurrentMinFees: vi.fn(),
      getNodeInfo: vi.fn(),
    };

    for (const estimatedGasPadding of [NaN, Infinity, -Infinity, -0.1]) {
      await expect(
        estimateGasSettings(interaction, {
          aztecNode,
          from,
          estimatedGasPadding,
        }),
      ).rejects.toThrow(/padding must be a non-negative finite number/);
    }

    // Fail fast: invalid padding is rejected before any node/simulation calls.
    expect(aztecNode.getCurrentMinFees).not.toHaveBeenCalled();
    expect(aztecNode.getNodeInfo).not.toHaveBeenCalled();
    expect(interaction.simulate).not.toHaveBeenCalled();
  });

  it('accepts zero padding, yielding limits equal to simulated usage', async () => {
    const from = await AztecAddress.random();
    const totalGas = Gas.from({ daGas: 100, l2Gas: 200 });
    const teardownGas = Gas.from({ daGas: 10, l2Gas: 20 });
    const interaction = {
      simulate: vi.fn().mockResolvedValue({
        gasUsed: { totalGas, teardownGas },
      }),
    };
    const aztecNode = {
      getCurrentMinFees: vi.fn().mockResolvedValue(new GasFees(10n, 20n)),
      getNodeInfo: vi.fn().mockResolvedValue({
        txsLimits: { gas: { daGas: 1_000_000, l2Gas: 2_000_000 } },
      }),
    };

    const gasSettings = await estimateGasSettings(interaction, {
      aztecNode,
      from,
      estimatedGasPadding: 0,
    });

    expect(gasSettings.gasLimits.daGas).toBe(100);
    expect(gasSettings.gasLimits.l2Gas).toBe(200);
    expect(gasSettings.teardownGasLimits.daGas).toBe(10);
    expect(gasSettings.teardownGasLimits.l2Gas).toBe(20);
  });
});
