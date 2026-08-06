/**
 * The mutation protocol: every state-changing operator call is expressed as an
 * immutable, digestible ActionPlan. The confirmation callback receives THAT
 * exact plan (and its digest); execution revalidates fresh chain reads against
 * the plan immediately before broadcast.
 *
 * Honest claim scope: this defeats staleness, races, and confused-deputy
 * substitution ("you confirmed X but Y was sent"). It does NOT defeat a
 * consistently lying RPC — endpoint trust is documented in the README, and
 * injected clients are still treated as hostile-capable (nothing here trusts a
 * client to echo back what was requested).
 */
import { createHash } from 'node:crypto';

export interface ActionPlan<K extends string = string> {
  /** What kind of irreversible thing this is, e.g. 'bridge-fee-juice'. */
  readonly kind: K;
  /** Everything the human is agreeing to: chain ids, addresses, amounts, revisions, loss bounds. */
  readonly details: Readonly<Record<string, string | number | boolean>>;
  /** sha256 over the canonicalized kind+details. */
  readonly digest: string;
}

/** Caller-supplied gate. Return true to proceed; anything else aborts. */
export type ConfirmAction = (plan: ActionPlan) => Promise<boolean> | boolean;

function canonicalize(value: Record<string, string | number | boolean>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((k) => [k, value[k]]),
  );
}

export function createActionPlan<K extends string>(
  kind: K,
  details: Record<string, string | number | boolean>,
): ActionPlan<K> {
  const digest = createHash('sha256')
    .update(`${kind}\n${canonicalize(details)}`)
    .digest('hex');
  return Object.freeze({ kind, details: Object.freeze({ ...details }), digest });
}

/**
 * Snapshots caller-supplied option bags for use after confirmation: plain
 * objects and arrays are copied RECURSIVELY, so a confirmation callback
 * mutating nested literals (`fee.gasSettings` etc.) cannot change what
 * executes (post-impl audit round 3, finding 4). Class instances (payment
 * methods, field elements) are kept by reference — they cannot be cloned
 * generically; that shared-reference residual is the documented limit.
 */
export function snapshotOptions<T extends Record<string, unknown>>(options: T): T {
  const copy = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(copy);
    if (v !== null && typeof v === 'object') {
      const proto = Object.getPrototypeOf(v);
      if (proto === Object.prototype || proto === null) {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
      }
    }
    return v;
  };
  return copy({ ...options }) as T;
}

export class ActionAborted extends Error {
  constructor(readonly plan: ActionPlan) {
    super(`aborted by operator: ${plan.kind} (${plan.digest.slice(0, 12)})`);
    this.name = 'ActionAborted';
  }
}

export class ActionRevalidationFailed extends Error {
  constructor(
    readonly plan: ActionPlan,
    detail: string,
  ) {
    super(
      `chain state changed between confirmation and broadcast for ${plan.kind}: ${detail}. ` +
        `Nothing was sent — re-read state and build a fresh plan.`,
    );
    this.name = 'ActionRevalidationFailed';
  }
}

/** Confirms the plan, then revalidates immediately before the caller broadcasts. */
export async function confirmAndRevalidate(
  plan: ActionPlan,
  confirm: ConfirmAction,
  revalidate: () => Promise<string | undefined>,
): Promise<void> {
  if ((await confirm(plan)) !== true) throw new ActionAborted(plan);
  const problem = await revalidate();
  if (problem !== undefined) throw new ActionRevalidationFailed(plan, problem);
}
