/**
 * `@alejoamiras/quota-paymaster/operator/config` — everything an operator's
 * config module needs, in one import.
 *
 *   import { defineOperatorConfig, schnorrAccountFromEnv } from '@alejoamiras/quota-paymaster/operator/config';
 *   export default defineOperatorConfig(schnorrAccountFromEnv());
 */
export {
  defineOperatorConfig,
  loadOperatorConfigModule,
  OperatorConfigError,
  type OperatorConfigErrorReason,
  type OperatorConfigFactory,
  type OperatorConfigModule,
  type OperatorContext,
  resolveOperatorContext,
} from './config-module.js';
export { type SchnorrAccountFromEnvOptions, schnorrAccountFromEnv } from './factories.js';
