/**
 * Config schema for the QuotaFpc paymaster.
 *
 * The Noir contract is app-agnostic: every application-specific value lives in
 * a JSON config validated here. Adopting the paymaster for an app means
 * writing one of these files — no contract changes.
 *
 * Browser-safe: `env:` indirection reads from an injected map, defaulting to
 * `process.env` only where a process exists.
 */

/** Maximum allowlist entries, must match MAX_ALLOWED_TARGETS in the contract. */
export const MAX_ALLOWED_TARGETS = 12;

/** Maximum account classes, must match MAX_ALLOWED_ACCOUNT_CLASSES in the contract. */
export const MAX_ALLOWED_ACCOUNT_CLASSES = 4;

export interface QuotaFpcPolicy {
  /**
   * Ceiling on what the paymaster will pay for a single transaction, in fee
   * juice wei. Asserted during private setup, so an over-budget transaction
   * cannot even be proven. Size it from measured costs times a headroom
   * multiplier — network base fees float, and a transaction that no longer fits
   * this ceiling simply falls back to the user paying.
   */
  maxFeeWei: string;
  /** Sponsored transactions per user per day. */
  maxUsesPerDay: number;
  /** Distinct users sponsored per day. */
  maxUsersPerDay: number;
}

export interface QuotaFpcTarget {
  /** Human label, used in logs and errors. */
  name: string;
  /**
   * Deployed address of a sponsored contract, or the name of an env var
   * holding it (prefix `env:`), so configs can avoid hardcoding addresses.
   */
  address: string;
}

export interface QuotaFpcAccountClass {
  /** Human label, used in logs and errors, e.g. "SchnorrInitializerlessAccount". */
  name: string;
  /**
   * The account contract's class id — a hash of its artifact, so it is pinned
   * to an `@aztec/accounts` VERSION, not to a network — or the name of an env
   * var holding it (prefix `env:`), like target addresses. The deploy tooling
   * recomputes ids from the installed artifacts and refuses to deploy on a
   * mismatch, so config drift from a dependency bump is caught before the
   * immutable allowlist ships with a stale id.
   */
  classId: string;
}

export interface QuotaFpcConfig {
  /** Identifier for this deployment, e.g. "my-app-mainnet". */
  name: string;
  /** Free-text note shown in deploy output — what this instance sponsors. */
  description?: string;
  policy: QuotaFpcPolicy;
  /** Contracts whose calls this paymaster will sponsor — their ENTIRE surface. */
  allowedTargets: QuotaFpcTarget[];
  /**
   * Account contract classes the paymaster will hand execution to. The
   * sandwich trusts the user's account to run the validated payload, so a
   * malicious account implementation could ignore it — this list restricts
   * sponsorship to account classes whose behavior is known.
   */
  allowedAccountClasses: QuotaFpcAccountClass[];
  /**
   * Require the user's account to be UNPUBLISHED at the anchor block.
   *
   * Defaults to true, and should stay true. The class allowlist alone binds
   * only the account's ORIGINAL class, while execution follows its CURRENT
   * one — and `ContractInstanceRegistry::update` can change that, so an
   * allowlisted account could upgrade to hostile code and still be sponsored.
   * `update` requires the caller to be published, so proving the account
   * unpublished is what makes the class binding mean "the code that will run".
   *
   * Set false only for a deployment that must sponsor published accounts and
   * explicitly accepts that upgrade path.
   */
  requireUnpublishedAccounts?: boolean;
  /**
   * The account permitted to schedule policy/allowlist changes.
   *
   * Required and explicit — there is deliberately no "default to the
   * deployer". The address is a constructor immutable with no transfer
   * function, so whoever is named here holds it permanently; a silent
   * default would mean approving a deployment without ever seeing who ends
   * up with the key (and a dry-run cannot show it without loading a signer).
   */
  adminAddress: string;
  /**
   * Total the operator is willing to lose, in fee juice wei. The deploy tooling
   * refuses to proceed beyond this — the paymaster has no withdraw, so this is
   * the real budget control.
   */
  maxLossWei: string;
}

export class QuotaFpcConfigError extends Error {}

/** Resolves `env:VAR` indirection; throws (naming the field) when unset. */
function resolveEnvIndirection(raw: string, field: string, env: Record<string, string | undefined>): string {
  const resolved = raw.startsWith('env:') ? env[raw.slice(4)]?.trim() : raw;
  if (!resolved) {
    throw new QuotaFpcConfigError(`${field} resolves to nothing: set ${raw.slice(4)}`);
  }
  return resolved;
}

/**
 * Shape / zero / field-modulus checks for one target address. Exported so the
 * policy-UPDATE path enforces the SAME rules as deploys — without this, a
 * typo'd target handed to schedulePolicyChange would be silently truncated by
 * the address parser into a DIFFERENT address, live 12h later.
 */
export function assertValidTargetAddress(address: string, label: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(address)) {
    throw new QuotaFpcConfigError(`${label} is not a 32-byte address: ${address}`);
  }
  // The zero address is the contract's "empty slot" marker; a named target
  // resolving to it would be silently dropped from the allowlist.
  if (/^0x0+$/.test(address)) {
    throw new QuotaFpcConfigError(`${label} is the zero address, which the contract treats as an empty slot`);
  }
  if (BigInt(address) >= FIELD_MODULUS) {
    throw new QuotaFpcConfigError(`${label} is not a valid field element: ${address}`);
  }
}

/** Count + dedup + per-address validation for a full target list. */
export function assertValidTargetList(addresses: string[], label = 'allowedTargets'): void {
  if (addresses.length === 0) {
    throw new QuotaFpcConfigError(`${label} must list at least one contract`);
  }
  if (addresses.length > MAX_ALLOWED_TARGETS) {
    throw new QuotaFpcConfigError(
      `${label} holds ${addresses.length} entries, but the contract allows ${MAX_ALLOWED_TARGETS}`,
    );
  }
  const seen = new Set<string>();
  for (const [index, address] of addresses.entries()) {
    assertValidTargetAddress(address, `${label}[${index}]`);
    const key = address.toLowerCase();
    if (seen.has(key)) {
      throw new QuotaFpcConfigError(`${label} lists ${address} twice`);
    }
    seen.add(key);
  }
}

/**
 * Worst case a single UTC day can cost, in fee-juice wei.
 *
 * The 3x is because around a rollover up to three generations are chargeable
 * within one day: a stale-but-valid anchor can spend the previous one, current
 * anchors the current one, and the closing grace window the next.
 *
 * Exported because three callers need the SAME number — schema validation, the
 * deploy summary, and the policy-update tooling. It was previously duplicated
 * between the first two, which is how they drift.
 *
 * NOTE: with a mutable policy this is a bound on the CURRENT settings only. It
 * is not a cap on anything — the contract enforces no such limit, and an admin
 * can schedule a larger policy later. The paymaster's balance is the only real
 * bound.
 */
export function worstCasePerDayWei(policy: {
  maxFeeWei: string | bigint;
  maxUsesPerDay: number;
  maxUsersPerDay: number;
}): bigint {
  return BigInt(policy.maxFeeWei) * BigInt(policy.maxUsesPerDay) * BigInt(policy.maxUsersPerDay) * 3n;
}

/** The contract's u128 fields cannot hold more than this. */
export const U128_MAX = 2n ** 128n - 1n;
/** The contract's u32 fields cannot hold more than this. */
export const U32_MAX = 2 ** 32 - 1;
/** BN254 scalar field modulus — a class id is a Field and must sit below it. */
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function requirePositiveBigint(value: string, field: string, max: bigint): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new QuotaFpcConfigError(`${field} must be an integer string, got ${JSON.stringify(value)}`);
  }
  if (parsed <= 0n) {
    throw new QuotaFpcConfigError(`${field} must be greater than zero, got ${value}`);
  }
  // The contract's field would silently wrap or the deploy would fail late; a
  // value this large is always a mistake, so reject it here with the reason.
  if (parsed > max) {
    throw new QuotaFpcConfigError(`${field} exceeds the contract's maximum (${max}), got ${value}`);
  }
  return parsed;
}

function requirePositiveInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new QuotaFpcConfigError(`${field} must be a positive integer, got ${value}`);
  }
  if (value > U32_MAX) {
    throw new QuotaFpcConfigError(`${field} exceeds the contract's u32 maximum (${U32_MAX}), got ${value}`);
  }
  return value;
}

/**
 * Validates a config and resolves any `env:` target addresses.
 * Throws QuotaFpcConfigError with an actionable message on any problem —
 * misconfiguring a paymaster that cannot be corrected after deploy is expensive.
 */
export function parseQuotaFpcConfig(
  raw: unknown,
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): QuotaFpcConfig & {
  adminAddress: string;
  requireUnpublishedAccounts: boolean;
  resolvedTargets: { name: string; address: string }[];
  /** Like resolvedTargets: env: indirection resolved, ready for BigInt(). */
  resolvedAccountClasses: { name: string; classId: string }[];
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new QuotaFpcConfigError('Config must be a JSON object');
  }
  const config = raw as QuotaFpcConfig;

  if (!config.name?.trim()) {
    throw new QuotaFpcConfigError('name is required');
  }
  if (!config.policy) {
    throw new QuotaFpcConfigError('policy is required');
  }

  const maxFee = requirePositiveBigint(config.policy.maxFeeWei, 'policy.maxFeeWei', U128_MAX);
  const maxUses = requirePositiveInt(config.policy.maxUsesPerDay, 'policy.maxUsesPerDay');
  const maxUsers = requirePositiveInt(config.policy.maxUsersPerDay, 'policy.maxUsersPerDay');
  // The cap must not sit below the worst case it is compared against:
  // worstCasePerDayWei is 3 x maxFee x maxUses x maxUsers, so a policy at the
  // field maxima needs a bound 3x this product to be expressible at all
  // (round-6 finding 4).
  const maxLoss = requirePositiveBigint(
    config.maxLossWei,
    'maxLossWei',
    3n * U128_MAX * BigInt(U32_MAX) * BigInt(U32_MAX),
  );

  if (!Array.isArray(config.allowedTargets) || config.allowedTargets.length === 0) {
    throw new QuotaFpcConfigError('allowedTargets must list at least one contract');
  }
  if (config.allowedTargets.length > MAX_ALLOWED_TARGETS) {
    throw new QuotaFpcConfigError(
      `allowedTargets holds ${config.allowedTargets.length} entries, but the contract allows ${MAX_ALLOWED_TARGETS}`,
    );
  }

  const resolvedTargets = config.allowedTargets.map((target, index) => {
    if (!target?.name?.trim()) {
      throw new QuotaFpcConfigError(`allowedTargets[${index}].name is required`);
    }
    const rawAddress = target.address?.trim();
    if (!rawAddress) {
      throw new QuotaFpcConfigError(`allowedTargets[${index}] (${target.name}) needs an address`);
    }
    const label = `allowedTargets[${index}] (${target.name})`;
    const address = resolveEnvIndirection(rawAddress, label, env);
    assertValidTargetAddress(address, label);
    return { name: target.name, address };
  });

  const seen = new Map<string, string>();
  for (const target of resolvedTargets) {
    const previous = seen.get(target.address.toLowerCase());
    if (previous) {
      throw new QuotaFpcConfigError(`allowedTargets lists ${target.address} twice (${previous} and ${target.name})`);
    }
    seen.set(target.address.toLowerCase(), target.name);
  }

  if (!Array.isArray(config.allowedAccountClasses) || config.allowedAccountClasses.length === 0) {
    throw new QuotaFpcConfigError(
      'allowedAccountClasses must list at least one account class — without it any account ' +
        'contract, including a malicious one, would be sponsored',
    );
  }
  if (config.allowedAccountClasses.length > MAX_ALLOWED_ACCOUNT_CLASSES) {
    throw new QuotaFpcConfigError(
      `allowedAccountClasses holds ${config.allowedAccountClasses.length} entries, but the contract allows ${MAX_ALLOWED_ACCOUNT_CLASSES}`,
    );
  }
  const seenClasses = new Map<string, string>();
  const resolvedAccountClasses: { name: string; classId: string }[] = [];
  for (const [index, accountClass] of config.allowedAccountClasses.entries()) {
    if (!accountClass?.name?.trim()) {
      throw new QuotaFpcConfigError(`allowedAccountClasses[${index}].name is required`);
    }
    // Same env: indirection targets and adminAddress support — class ids are
    // version-pinned values an example config cannot sensibly hardcode.
    const rawClassId = accountClass.classId?.trim();
    const classId = rawClassId
      ? resolveEnvIndirection(rawClassId, `allowedAccountClasses[${index}] (${accountClass.name})`, env)
      : rawClassId;
    if (!classId || !/^0x[0-9a-fA-F]{1,64}$/.test(classId)) {
      throw new QuotaFpcConfigError(
        `allowedAccountClasses[${index}] (${accountClass.name}) needs a 0x-hex classId, got ${JSON.stringify(accountClass.classId)}`,
      );
    }
    const value = BigInt(classId);
    // Zero is the contract's "empty slot" marker; a named class resolving to it
    // would be silently dropped. Values at or above the field modulus would be
    // reduced on-chain and match a different id than the config says.
    if (value === 0n) {
      throw new QuotaFpcConfigError(
        `allowedAccountClasses[${index}] (${accountClass.name}) is zero, which the contract treats as an empty slot`,
      );
    }
    if (value >= FIELD_MODULUS) {
      throw new QuotaFpcConfigError(
        `allowedAccountClasses[${index}] (${accountClass.name}) is not a valid field element: ${classId}`,
      );
    }
    const key = value.toString(16);
    const previous = seenClasses.get(key);
    if (previous) {
      throw new QuotaFpcConfigError(
        `allowedAccountClasses lists ${classId} twice (${previous} and ${accountClass.name})`,
      );
    }
    seenClasses.set(key, accountClass.name);
    resolvedAccountClasses.push({ name: accountClass.name, classId });
  }

  if (config.requireUnpublishedAccounts !== undefined && typeof config.requireUnpublishedAccounts !== 'boolean') {
    throw new QuotaFpcConfigError(
      `requireUnpublishedAccounts must be a boolean, got ${JSON.stringify(config.requireUnpublishedAccounts)}`,
    );
  }
  // Absent means true: the safe posture must be what you get by default.
  const requireUnpublishedAccounts = config.requireUnpublishedAccounts ?? true;

  const rawAdmin = config.adminAddress?.trim();
  if (!rawAdmin) {
    throw new QuotaFpcConfigError(
      'adminAddress is required: name the account that may schedule policy changes. ' +
        'It is immutable and has no transfer function, so whoever is named holds it permanently.',
    );
  }
  // Same env: indirection the targets support. This is still explicit — the
  // operator must set the variable deliberately, and a dry-run prints the
  // resolved value without loading any signer. What it is NOT is a fallback:
  // an unset variable is an error, never "use the deployer".
  const adminAddress = resolveEnvIndirection(rawAdmin, 'adminAddress', env);
  if (!/^0x[0-9a-fA-F]{64}$/.test(adminAddress)) {
    throw new QuotaFpcConfigError(`adminAddress is not a 32-byte address: ${adminAddress}`);
  }
  if (/^0x0+$/.test(adminAddress)) {
    throw new QuotaFpcConfigError('adminAddress is the zero address, which would permanently brick policy updates');
  }
  // An address is a field element. A value at or above the modulus is not a
  // real address: it would be reduced on conversion, so the contract's admin
  // would be a DIFFERENT account than the config names — and since the admin
  // is immutable with no transfer, control would be permanently lost.
  if (BigInt(adminAddress) >= FIELD_MODULUS) {
    throw new QuotaFpcConfigError(
      `adminAddress is not a valid field element: ${adminAddress}. ` +
        'Deploying this would hand control to a different (unreachable) account.',
    );
  }

  // Worst case a single UTC day can cost, versus what the operator accepts
  // losing. NOTE the 3x: around a rollover, a stale-but-valid anchor can spend
  // the previous generation, current anchors the current one, and the last 600s
  // grace window the next — up to three generations chargeable within one day.
  // (See the freshness logic in the contract.) Surfaced as a hard error because
  // there is no withdraw, so this bound is the operator's real exposure.
  //
  // This is validation only. It does NOT cap on-chain spending — the contract
  // has no such limit — so the paymaster's *balance* remains the ultimate cap.
  // Fund in tranches accordingly.
  const worstCasePerDay = worstCasePerDayWei({
    maxFeeWei: maxFee,
    maxUsesPerDay: maxUses,
    maxUsersPerDay: maxUsers,
  });
  if (worstCasePerDay > maxLoss) {
    throw new QuotaFpcConfigError(
      `Initial policy allows up to ${worstCasePerDay} wei/day (3 x maxFee x maxUses x maxUsers, for the ~3 generations ` +
        `spendable around a rollover) but maxLossWei is ${maxLoss}. Lower the policy or raise the loss budget ` +
        `deliberately. NOTE: this checks the INITIAL policy only — the admin can schedule a larger one after deploy, ` +
        `so maxLossWei is a sanity check, not a bound. Funds sent to the paymaster cannot be recovered, and its ` +
        `balance is the only real cap.`,
    );
  }

  return { ...config, adminAddress, requireUnpublishedAccounts, resolvedTargets, resolvedAccountClasses };
}

/** Pads the allowlist to the contract's fixed-size array with zero addresses. */
export function padAllowedTargets(addresses: string[]): string[] {
  if (addresses.length > MAX_ALLOWED_TARGETS) {
    throw new QuotaFpcConfigError(`Too many targets: ${addresses.length} > ${MAX_ALLOWED_TARGETS}`);
  }
  const zero = `0x${'0'.repeat(64)}`;
  return [...addresses, ...Array(MAX_ALLOWED_TARGETS - addresses.length).fill(zero)];
}

/** Pads the account-class allowlist to the contract's fixed-size array with zeros. */
export function padAllowedAccountClasses(classIds: bigint[]): bigint[] {
  if (classIds.length > MAX_ALLOWED_ACCOUNT_CLASSES) {
    throw new QuotaFpcConfigError(`Too many account classes: ${classIds.length} > ${MAX_ALLOWED_ACCOUNT_CLASSES}`);
  }
  return [...classIds, ...Array(MAX_ALLOWED_ACCOUNT_CLASSES - classIds.length).fill(0n)];
}
