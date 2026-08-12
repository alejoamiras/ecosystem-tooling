/** `policy` — read live/pending policy, and schedule or cancel a change. */
import { readFileSync } from 'node:fs';
import { assertValidTargetList, parseQuotaFpcConfig } from '../../config/schema.js';
import { assertValidGasProfile, type GasProfile } from '../../gas-profile.js';
import { formatFeeJuiceWei } from '../../operator/internal/format.js';
import { cancelPendingPolicyChange, readPolicyState, schedulePolicyChange } from '../../operator/policy.js';
import { makeConfirm } from '../internal/confirm.js';
import { withContext } from '../internal/context.js';
import { CliUsageError, type FlagSchema, type ParsedFlags, requireAddressFlag } from '../internal/flags.js';

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

/**
 * The gas envelope is ALWAYS explicit — from the config module or --gas-profile.
 * There is deliberately no default: the fee floor derived from someone else's
 * profile can approve a ceiling that silently stops sponsorship for YOUR app.
 */
function gasProfileFrom(flags: ParsedFlags, fromContext: GasProfile | undefined): GasProfile {
  if (fromContext) return fromContext;
  const path = flags.get('gas-profile');
  if (!path) {
    throw new CliUsageError(
      'a gas profile is required: return `gasProfile` from your config module, or pass ' +
        '--gas-profile <json> with YOUR measured numbers (measure them with the `measure` command). ' +
        'There is deliberately no default — a foreign profile can approve a ceiling that stops sponsorship.',
    );
  }
  let profile: GasProfile;
  try {
    profile = JSON.parse(readFileSync(path, 'utf8')) as GasProfile;
  } catch {
    throw new CliUsageError(`cannot read --gas-profile ${path} as JSON`);
  }
  try {
    // Semantic check here too: a syntactically fine but nonsensical profile
    // would otherwise fail as a RangeError mid-computation (exit 1) rather
    // than as the usage refusal it is.
    assertValidGasProfile(profile);
  } catch (error) {
    throw new CliUsageError(`--gas-profile ${path} is invalid: ${(error as Error).message}`);
  }
  return profile;
}

/** The loss bound binds updates too, so it may come from the deploy config. */
function maxLossWeiFrom(flags: ParsedFlags): bigint {
  const direct = flags.get('max-loss-wei');
  if (direct) return parseBigint(direct, 'max-loss-wei');
  const configPath = flags.get('config');
  if (configPath) {
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf8');
    } catch {
      throw new CliUsageError(`cannot read --config ${configPath}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CliUsageError(`--config ${configPath} is not valid JSON`);
    }
    return BigInt(parseQuotaFpcConfig(parsed).maxLossWei);
  }
  throw new CliUsageError(
    'a loss bound is required for any policy edit: pass --max-loss-wei <N>, or --config <deploy.json> ' +
      'to reuse the bound accepted at deploy time.',
  );
}

/** Malformed numbers are usage refusals (nothing happened), never failures. */
function parseBigint(raw: string, flag: string): bigint {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    throw new CliUsageError(`--${flag} must be an integer (got "${raw}")`);
  }
  // max_fee is a u128 on-chain and must be non-zero (assert_bundle_sane).
  if (flag === 'max-fee-wei' && (value < 1n || value > (1n << 128n) - 1n)) {
    throw new CliUsageError('--max-fee-wei must be an integer in 1..2^128-1');
  }
  if (value < 0n) throw new CliUsageError(`--${flag} must not be negative`);
  return value;
}

/**
 * The contract requires max_uses/max_users >= 1 and stores them as u32, so a 0
 * or an out-of-range value is refused HERE rather than reverting after the
 * operator has confirmed a plan.
 */
function parseCount(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 0xff_ff_ff_ff) {
    throw new CliUsageError(`--${flag} must be an integer in 1..4294967295`);
  }
  return value;
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
  const fpcAddress = AztecAddress.fromStringUnsafe(requireAddressFlag(flags, 'fpc'));

  // Everything that can be judged from argv + local files is judged BEFORE the
  // config module runs: loading a config executes the operator's own code, and
  // an invocation already known to be invalid should never reach it.
  const isEdit = !flags.has('show');
  const change = isEdit
    ? {
        maxFeeWei: flags.get('max-fee-wei') ? parseBigint(flags.require('max-fee-wei'), 'max-fee-wei') : undefined,
        maxUses: flags.get('max-uses') ? parseCount(flags.require('max-uses'), 'max-uses') : undefined,
        maxUsers: flags.get('max-users') ? parseCount(flags.require('max-users'), 'max-users') : undefined,
      }
    : undefined;
  const maxLossWei = isEdit ? maxLossWeiFrom(flags) : undefined;
  // Everything else judgeable from argv + local files, also BEFORE user code:
  // the gas-profile FILE (when supplied), target syntax, and a no-op edit.
  // --cancel schedules the LIVE values; combining it with edit flags would
  // silently execute a different mutation than the one asked for.
  // --show has the same problem and had no guard: `policy --show --max-uses 5
  // --yes` printed the state and exited 0 having scheduled NOTHING, with no
  // plan and no warning (round-13).
  // ...and not each other: --show returns before the cancel runs, so the pair
  // exited 0 having cancelled nothing (round-14).
  // --max-loss-wei and --config both supply the loss bound, and the direct
  // value silently won — applying a different safety bound than the config the
  // operator pointed at. The usage string already documents them as
  // alternatives (round-15).
  if (flags.has('max-loss-wei') && flags.has('config')) {
    throw new CliUsageError('pass either --max-loss-wei or --config for the loss bound, not both');
  }
  if (flags.has('show') && flags.has('cancel')) {
    throw new CliUsageError('--show and --cancel do different things; run them as separate commands');
  }
  for (const mode of ['cancel', 'show'] as const) {
    if (!flags.has(mode)) continue;
    // --show also silently dropped the loss bound and the accept-* overrides,
    // which exist only to authorize an edit (round-16).
    const editFlags =
      mode === 'show'
        ? [
            'max-fee-wei',
            'max-uses',
            'max-users',
            'add-target',
            'remove-target',
            'max-loss-wei',
            'config',
            'accept-below-floor',
            'accept-above-max-loss',
          ]
        : ['max-fee-wei', 'max-uses', 'max-users', 'add-target', 'remove-target'];
    const conflicting = editFlags.filter((f) => flags.has(f));
    if (conflicting.length > 0) {
      throw new CliUsageError(
        `--${mode} ${mode === 'cancel' ? 'restores the live policy' : 'only reports state'} and cannot be combined ` +
          `with edit flags (${conflicting.map((f) => `--${f}`).join(', ')}). Run them as separate commands.`,
      );
    }
  }
  const gasProfileFromFlag = flags.get('gas-profile') ? gasProfileFrom(flags, undefined) : undefined;
  const addTargets = flags.list('add-target');
  const removeTargets = flags.list('remove-target');
  if (addTargets.length > 0) assertValidTargetList(addTargets);
  if (removeTargets.length > 0) assertValidTargetList(removeTargets);
  // The same target in both lists is a contradiction, and addition won
  // silently — keeping a target the same command asked to remove (round-15).
  const removedSet = new Set(removeTargets.map((t) => t.toLowerCase()));
  const contradictory = addTargets.filter((t) => removedSet.has(t.toLowerCase()));
  if (contradictory.length > 0) {
    throw new CliUsageError(`${contradictory.join(', ')} appears in both --add-target and --remove-target; pick one`);
  }
  if (
    isEdit &&
    !flags.has('cancel') &&
    addTargets.length === 0 &&
    removeTargets.length === 0 &&
    change !== undefined &&
    Object.values(change).every((v) => v === undefined)
  ) {
    throw new CliUsageError('nothing to change — pass --show to read only, or at least one edit flag.');
  }

  await withContext(flags, async (ctx) => {
    const gasProfile = gasProfileFromFlag ?? gasProfileFrom(flags, ctx.gasProfile);
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
      maxLossWei: maxLossWei as bigint,
      gasProfile,
      acceptCeilingBelowClientFloor: flags.has('accept-below-floor'),
      acceptWorstCaseAboveMaxLoss: flags.has('accept-above-max-loss'),
    };
    const confirm = makeConfirm(flags);

    if (flags.has('cancel')) {
      const result = await cancelPendingPolicyChange({ ...deps, confirm, sendOptions: ctx.sendOptions }, guards);
      reportRace(result.pendingActivatedFirst, 'cancel');
      console.log(`\nPending change replaced with the live values (revision ${result.scheduledRevision}).`);
      return;
    }

    // Target edits are a full-list replacement computed against live state
    // (their SYNTAX was already validated before any user code ran).
    // Lowercased: an address differing only in case is the SAME target, and
    // feeding the typed spelling into the plan made the digest depend on how
    // the operator capitalised it (round-17).
    const added = addTargets.map((t) => t.toLowerCase());
    const removed = removeTargets.map((t) => t.toLowerCase());
    let allowedTargets: string[] | undefined;
    if (added.length > 0 || removed.length > 0) {
      const kept = state.live.allowedTargets.filter((t) => !removed.includes(t.toLowerCase()));
      const known = new Set(kept.map((t) => t.toLowerCase()));
      allowedTargets = [...kept, ...added.filter((t) => !known.has(t.toLowerCase()))];
    }

    const edit = { ...(change as NonNullable<typeof change>), allowedTargets };
    const result = await schedulePolicyChange({ ...deps, confirm, sendOptions: ctx.sendOptions }, edit, guards);
    reportRace(result.pendingActivatedFirst, 'schedule');
    console.log(`\nScheduled (revision ${result.scheduledRevision}). Takes effect in 12h; one pending slot.`);
  });
}
