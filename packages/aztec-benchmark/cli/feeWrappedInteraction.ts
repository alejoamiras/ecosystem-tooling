import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import {
  ContractFunctionInteraction,
  type GasSettingsOption,
  type RequestInteractionOptions,
  type SimulateInteractionOptions,
  type ProfileInteractionOptions,
  type SendInteractionOptions,
} from '@aztec/aztec.js/contracts';
import { AztecAddress } from '@aztec/aztec.js/addresses';

import type { NamedBenchmarkedInteraction } from './types.js';

/** Partial gas settings that can be injected into every profiler call. */
export type FeeGasSettings = NonNullable<GasSettingsOption['gasSettings']>;

/** Fee configuration injected by FeeWrappedInteraction and namedMethod. */
export interface FeeOptions {
  paymentMethod?: FeePaymentMethod;
  gasSettings?: FeeGasSettings;
}

/**
 * Wraps a ContractFunctionInteraction so the benchmark profiler always uses a
 * per-interaction FeePaymentMethod and gas settings.
 *
 * The profiler only supports a single global feePaymentMethod, but benchmarks
 * often require different methods per interaction. This class intercepts every
 * profiler call and injects the configured method and settings.
 */
export class FeeWrappedInteraction {
  constructor(
    private readonly inner: ContractFunctionInteraction,
    private readonly paymentMethod?: FeePaymentMethod,
    private readonly gasSettings?: FeeGasSettings,
  ) {}

  async request(options: RequestInteractionOptions = {}) {
    // `RequestInteractionOptions.fee` is `FeePaymentMethodOption` — it only carries
    // `paymentMethod`, not `gasSettings`. Gas settings are injected by `withFee` in
    // simulate/profile/send where the fee type supports them.
    const paymentMethod = options.fee?.paymentMethod ?? this.paymentMethod;
    return paymentMethod
      ? this.inner.request({
          ...options,
          fee: { ...(options.fee ?? {}), paymentMethod },
        })
      : this.inner.request(options);
  }

  async simulate(options?: SimulateInteractionOptions) {
    return this.inner.simulate(this.withFee(options));
  }

  async profile(options?: ProfileInteractionOptions) {
    return this.inner.profile(this.withFee(options));
  }

  async send(options?: SendInteractionOptions) {
    return this.inner.send(this.withFee(options));
  }

  private withFee<T extends SimulateInteractionOptions | ProfileInteractionOptions | SendInteractionOptions>(
    options?: T,
  ): T {
    const paymentMethod = options?.fee?.paymentMethod ?? this.paymentMethod;
    if (!paymentMethod) return (options ?? {}) as T;
    return {
      ...(options ?? {}),
      fee: {
        ...(options?.fee ?? {}),
        paymentMethod,
        ...(this.gasSettings && { gasSettings: this.gasSettings }),
      },
    } as T;
  }
}

/**
 * Creates a NamedBenchmarkedInteraction that wraps `inner` with an optional
 * FeePaymentMethod and gas settings.
 */
export function namedMethod(
  name: string,
  caller: AztecAddress,
  inner: ContractFunctionInteraction,
  fee?: FeeOptions,
): NamedBenchmarkedInteraction {
  return {
    name,
    interaction: {
      caller,
      action: new FeeWrappedInteraction(
        inner,
        fee?.paymentMethod,
        fee?.gasSettings,
      ) as unknown as ContractFunctionInteraction,
    },
  };
}
