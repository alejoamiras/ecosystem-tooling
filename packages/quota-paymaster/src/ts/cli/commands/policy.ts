/** `policy` — read live/pending policy, and schedule or cancel a change. */
import { readFileSync } from 'node:fs';
import { parseQuotaFpcConfig } from '../../config/schema.js';
import { DARK_FOREST_REFERENCE_GAS_PROFILE, type GasProfile } from '../../gas-profile.js';
import { formatFeeJuiceWei } from '../../operator/internal/format.js';
import { cancelPendingPolicyChange, readPolicyState, schedulePolicyChange } from '../../operator/policy.js';
import { makeConfirm } from '../internal/confirm.js';
import { withContext } from '../internal/context.js';
import { CliUsageError, type FlagSchema, type ParsedFlags } from '../internal/flags.js';

export const schema: FlagSchema = {
  fpc: { type: 'string' },
  'config-module': { type: 'string' },
  show: { type: 'boolean' },
  'max-fee-wei': { type: 'string' },
  'max-uses': { type: 'string' },
  'max-users': { type: 'string' },
  'add-target': { type: 'string', repeatable: true },
  'remove-target': { type: 'string', repeatable: true },
  cancel: { type: 'boolean' },
  'max-loss-wei': { type: 'string' },
  config: { type: 'string' },
  'gas-profile': { type: 'string' },
  'accept-below-floor': { type: 'boolean' },
  'accept-above-max-loss': { type: 'boolean' },
  yes: { type: 'boolean' },
};

export const usage =
  'policy --fpc 0x… --config-module <path> [--show]\n' +
  '       [--max-fee-wei N] [--max-uses N] [--max-users N]\n' +
  '       [--add-target 0x… …] [--remove-target 0x… …] [--cancel]\n' +
  '       [--max-loss-wei N | --config <deploy.json>] [--gas-profile <json>]\n' +
  '       [--accept-below-floor] [--accept-above-max-loss] [--yes]\n' +
  '  --show reads only. Any edit needs a loss bound: --max-loss-wei, or --config\n' +
  '  to reuse the bound accepted at deploy time.';

/** Operators SHOULD measure their own; the reference profile is labeled data. */
function gasProfileFrom(flags: ParsedFlags): GasProfile {
  const path = flags.get('gas-profile');
  if (path) return JSON.parse(readFileSync(path, 'utf8')) as GasProfile;
  console.warn('  (using DARK_FOREST_REFERENCE_GAS_PROFILE — pass --gas-profile <json> with YOUR measured numbers)');
  return DARK_FOREST_REFERENCE_GAS_PROFILE;
}

/** The loss bound binds updates too, so it may come from the deploy config. */
function maxLossWeiFrom(flags: ParsedFlags): bigint {
  const direct = flags.get('max-loss-wei');
  if (direct) return BigInt(direct);
  const configPath = flags.get('config');
  if (configPath) return BigInt(parseQuotaFpcConfig(JSON.parse(readFileSync(configPath, 'utf8'))).maxLossWei);
  throw new CliUsageError(
    'a loss bound is required for any policy edit: pass --max-loss-wei <N>, or --config <deploy.json> ' +
      'to reuse the bound accepted at deploy time.',
  );
}

function reportRace(pendingActivatedFirst: boolean | 'unknown', verb: string): void {
  if (pendingActivatedFirst === true) {
    console.error(
      `\nWARNING: the previously-pending change ACTIVATED before this ${verb} landed — it is LIVE NOW; ` +
        'your confirmed values replace it in ~12h. Review `policy --show`.',
    );
  } else if (pendingActivatedFirst === 'unknown') {
    console.error(
      `\nNOTE: the ${verb} SUCCEEDED (checkpointed), but the follow-up read to determine whether the ` +
        `pending change activated first failed. Do NOT re-run it — run \`policy --show\` to see the outcome.`,
    );
  }
}

export async function run(flags: ParsedFlags): Promise<void> {
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const fpcAddress = AztecAddress.fromStringUnsafe(flags.require('fpc'));

  await withContext(flags, async (ctx) => {
    const gasProfile = ctx.gasProfile ?? gasProfileFrom(flags);
    const deps = { node: ctx.node, wallet: ctx.wallet, from: ctx.from, fpcAddress };

    const state = await readPolicyState(deps, gasProfile);
    console.log(`\nPaymaster ${fpcAddress.toString()}`);
    console.log(`  admin        ${state.admin}`);
    console.log(
      `  live policy  maxFee ${formatFeeJuiceWei(state.live.maxFeeWei)}, ${state.live.maxUses} tx/user/day, ${state.live.maxUsers} users/day`,
    );
    for (const target of state.live.allowedTargets) console.log(`  target       ${target}`);
    console.log(
      `  scheduled    rev ${state.scheduled.revision}${state.scheduled.pending ? ` PENDING (activates at chain t=${state.scheduled.activatesAt})` : ' (in force)'}`,
    );
    console.log(`  balance      ${formatFeeJuiceWei(state.balanceWei)}`);
    console.log(
      `  reserve      ${formatFeeJuiceWei(state.sequencerReserveWei)} (below this the sequencer admits NOTHING sponsored)`,
    );
    if (state.balanceWei < state.sequencerReserveWei) {
      console.log('  ** BALANCE BELOW RESERVE: this paymaster currently sponsors NOTHING. **');
    }
    if (flags.has('show')) return;

    const guards = {
      maxLossWei: maxLossWeiFrom(flags),
      gasProfile,
      acceptCeilingBelowClientFloor: flags.has('accept-below-floor'),
      acceptWorstCaseAboveMaxLoss: flags.has('accept-above-max-loss'),
    };
    const confirm = makeConfirm(flags);

    if (flags.has('cancel')) {
      const result = await cancelPendingPolicyChange({ ...deps, confirm }, guards);
      reportRace(result.pendingActivatedFirst, 'cancel');
      console.log(`\nPending change replaced with the live values (revision ${result.scheduledRevision}).`);
      return;
    }

    // Target edits are a full-list replacement computed against live state.
    const added = flags.list('add-target');
    const removed = flags.list('remove-target').map((t) => t.toLowerCase());
    let allowedTargets: string[] | undefined;
    if (added.length > 0 || removed.length > 0) {
      const kept = state.live.allowedTargets.filter((t) => !removed.includes(t.toLowerCase()));
      const known = new Set(kept.map((t) => t.toLowerCase()));
      allowedTargets = [...kept, ...added.filter((t) => !known.has(t.toLowerCase()))];
    }

    const change = {
      maxFeeWei: flags.get('max-fee-wei') ? BigInt(flags.require('max-fee-wei')) : undefined,
      maxUses: flags.get('max-uses') ? Number(flags.require('max-uses')) : undefined,
      maxUsers: flags.get('max-users') ? Number(flags.require('max-users')) : undefined,
      allowedTargets,
    };
    if (Object.values(change).every((v) => v === undefined)) {
      throw new CliUsageError('nothing to change — pass --show to read only, or at least one edit flag.');
    }
    const result = await schedulePolicyChange({ ...deps, confirm }, change, guards);
    reportRace(result.pendingActivatedFirst, 'schedule');
    console.log(`\nScheduled (revision ${result.scheduledRevision}). Takes effect in 12h; one pending slot.`);
  });
}
