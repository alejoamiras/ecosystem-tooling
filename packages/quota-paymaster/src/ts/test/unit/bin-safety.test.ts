/**
 * The published CLI's safety contract, exercised by running the REAL binary as
 * a subprocess (same discipline as cli-safety.test.ts): argv handling and exit
 * codes ARE the behavior under test, so in-process calls would prove less.
 *
 * Entry point note: these run the CLI from SOURCE (`bun src/ts/cli/main.ts`)
 * because CI runs vitest before the dist build. The compiled launcher is proven
 * separately by the clean-room tarball probe, which installs the built package.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = join(PKG_ROOT, 'src/ts/cli/main.ts');

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  combined: string;
}

function run(args: string[], env: Record<string, string> = {}, stdin?: string): RunResult {
  try {
    const stdout = execFileSync('bun', [CLI, ...args], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
      // A piped stdin when the case under test supplies one; otherwise ignored
      // so nothing can block on a terminal that is not there.
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      input: stdin,
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '', combined: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    const stdout = e.stdout ?? '';
    const stderr = e.stderr ?? '';
    return { status: e.status ?? -1, stdout, stderr, combined: `${stdout}${stderr}` };
  }
}

/** A config module whose factory must never run in these tests. */
function poisonConfig(): string {
  const dir = tempDir('quota-bin-cfg-');
  const path = join(dir, 'poison.config.mjs');
  writeFileSync(path, `throw new Error('CONFIG_FACTORY_RAN — it must not for refused invocations');`);
  return path;
}

describe('published CLI: help and dispatch', () => {
  test('bare invocation prints usage and exits 0, touching no network', () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/npx @alejoamiras\/quota-paymaster/);
  });

  test('--help exits 0 for EVERY command without a config or a network', () => {
    for (const command of ['deploy', 'policy', 'bridge', 'claim', 'measure']) {
      const result = run([command, '--help']);
      expect(result.status, `${command} --help`).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    }
  });

  test('an unknown command names itself and exits 2', () => {
    const result = run(['withdraw']);
    expect(result.status).toBe(2);
    expect(result.combined).toMatch(/unknown command withdraw/);
  });

  test('the docs never advertise the unscoped npx name (it is not this package)', () => {
    const usage = run([]).stdout;
    expect(usage).toMatch(/@alejoamiras\/quota-paymaster/);
    expect(usage).not.toMatch(/npx quota-paymaster\b/);
  });
});

describe('published CLI: argv secret refusal', () => {
  test('--secret is refused in BOTH spellings, before anything else runs', () => {
    for (const args of [
      ['claim', '--for', '0x1', '--secret', 'deadbeef'],
      ['claim', '--for', '0x1', '--secret=deadbeef'],
    ]) {
      const result = run(args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.combined).toMatch(/REFUSED/);
      // The secret itself must not be echoed back in the refusal.
      expect(result.combined).not.toContain('deadbeef');
    }
  });

  test('the refusal covers every command, not just claim', () => {
    for (const command of ['deploy', 'policy', 'bridge', 'claim', 'measure']) {
      const result = run([command, '--secret=abc123']);
      expect(result.status, command).toBe(2);
      expect(result.combined).toMatch(/REFUSED/);
      expect(result.combined).not.toContain('abc123');
    }
  });

  test('other key-shaped flags are refused too', () => {
    for (const flag of ['--private-key=0xabc', '--l1-private-key=0xabc', '--claim-secret=0xabc']) {
      const result = run(['bridge', flag]);
      expect(result.status, flag).toBe(2);
      expect(result.combined).toMatch(/REFUSED/);
    }
  });
});

describe('published CLI: strict flag parsing', () => {
  test('an unknown flag is rejected rather than silently ignored', () => {
    const result = run(['policy', '--fpc', '0x1', '--maxuses', '3']);
    expect(result.status).toBe(2);
    expect(result.combined).toMatch(/unknown flag --maxuses/);
  });

  test('a repeated single-value flag is rejected (it used to overwrite silently)', () => {
    const result = run(['policy', '--fpc', '0x1', '--fpc', '0x2']);
    expect(result.status).toBe(2);
    expect(result.combined).toMatch(/given more than once/);
  });

  test('a value-less string flag is rejected', () => {
    const result = run(['policy', '--fpc']);
    expect(result.status).toBe(2);
    expect(result.combined).toMatch(/requires a value/);
  });
});

describe('published CLI: nothing runs without an explicit config module', () => {
  test('every chain-touching command refuses when --config-module is absent', () => {
    // deploy gets a VALID config so the missing config module is what stops it
    // (an unreadable or invalid config would refuse earlier — that's the next
    // test). Self-contained rather than the shipped example, which uses `env:`
    // indirection this test deliberately does not set.
    const validConfig = join(tempDir('quota-bin-validcfg-'), 'valid.json');
    writeFileSync(
      validConfig,
      JSON.stringify({
        name: 'fixture',
        policy: { maxFeeWei: '100000000000000000000', maxUsesPerDay: 5, maxUsersPerDay: 20 },
        // Values must be BN254 field elements — 0x2/0x3/0x4-repeated would
        // exceed the modulus and be rejected for that reason instead.
        allowedTargets: [{ name: 'T', address: `0x${'1'.repeat(64)}` }],
        allowedAccountClasses: [{ name: 'SchnorrInitializerlessAccount', classId: '0x1234' }],
        requireUnpublishedAccounts: true,
        adminAddress: `0x${'1'.repeat(63)}2`,
        maxLossWei: '30000000000000000000000',
      }),
    );
    const invocations: string[][] = [
      ['deploy', '--config', validConfig],
      ['policy', '--fpc', `0x${'1'.repeat(64)}`, '--show'],
      ['bridge', '--to', `0x${'1'.repeat(64)}`, '--amount-wei', '1'],
      ['claim', '--for', `0x${'1'.repeat(64)}`],
    ];
    for (const args of invocations) {
      const result = run(args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.combined, args.join(' ')).toMatch(/--config-module <path> is required/);
    }
  });

  test('an unreadable deploy config refuses offline, before any config module loads', () => {
    const result = run(['deploy', '--config', 'nope.json', '--config-module', poisonConfig()]);
    expect(result.status).toBe(2);
    expect(result.combined).toMatch(/cannot read --config/);
    expect(result.combined).not.toMatch(/CONFIG_FACTORY_RAN/);
  });

  test('there is no working-directory auto-discovery (a cwd config is NOT executed)', () => {
    // The ambient-execution hole: dropping a config into a directory must not
    // make it run just because a command was invoked there.
    const dir = tempDir('quota-bin-cwd-');
    writeFileSync(join(dir, 'quota-paymaster.config.mjs'), `throw new Error('AMBIENT_CONFIG_RAN');`);
    const result = (() => {
      try {
        const stdout = execFileSync('bun', [CLI, 'policy', '--fpc', `0x${'1'.repeat(64)}`, '--show'], {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: 0, combined: stdout };
      } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? -1, combined: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    })();
    expect(result.combined).not.toMatch(/AMBIENT_CONFIG_RAN/);
    expect(result.status).toBe(2);
  });
});

describe('published CLI: offline refusals happen before the config factory runs', () => {
  test('a malformed deploy config is rejected without executing the config module', () => {
    const dir = tempDir('quota-bin-deploy-');
    const badConfig = join(dir, 'bad.json');
    writeFileSync(badConfig, JSON.stringify({ name: 'x' }));
    const result = run(['deploy', '--config', badConfig, '--config-module', poisonConfig()]);
    expect(result.status).toBe(2);
    expect(result.combined).not.toMatch(/CONFIG_FACTORY_RAN/);
  });

  test('a usage error is reported without executing the config module', () => {
    const result = run(['bridge', '--to', `0x${'1'.repeat(64)}`, '--config-module', poisonConfig()]);
    expect(result.status).toBe(2);
    expect(result.combined).not.toMatch(/CONFIG_FACTORY_RAN/);
    expect(result.combined).toMatch(/--amount-wei|--amount/);
  });
});

describe('published CLI: key material never reaches the output', () => {
  const SECRET_KEY = '0x00000000000000000000000000000000000000000000000000000000deadbee1';
  const SIGNING_KEY = '0x00000000000000000000000000000000000000000000000000000000deadbee2';
  const MALFORMED = 'zzz-deadbee3-not-a-field';

  test('a malformed key in the environment never appears in stdout or stderr', () => {
    const dir = tempDir('quota-bin-keys-');
    const configPath = join(dir, 'env.config.mjs');
    // Points at the real factory, so the real parse path runs.
    writeFileSync(
      configPath,
      `import { defineOperatorConfig, schnorrAccountFromEnv } from '${join(PKG_ROOT, 'src/ts/operator/config.ts')}';\n` +
        `export default defineOperatorConfig(schnorrAccountFromEnv());\n`,
    );
    const result = run(['policy', '--fpc', `0x${'1'.repeat(64)}`, '--show', '--config-module', configPath], {
      ACCOUNT_SECRET_KEY: MALFORMED,
      ACCOUNT_SALT: '0x1',
      ACCOUNT_SIGNING_KEY: SIGNING_KEY,
      QUOTA_CLI_DEBUG: '1', // even in debug mode, values stay out
    });
    expect(result.status).not.toBe(0);
    expect(result.combined).not.toContain(MALFORMED);
    expect(result.combined).not.toContain(SIGNING_KEY);
    expect(result.combined).toMatch(/ACCOUNT_SECRET_KEY/);
  });

  test('a well-formed key is never echoed either, even when the run fails later', () => {
    const dir = tempDir('quota-bin-keys2-');
    const configPath = join(dir, 'env.config.mjs');
    writeFileSync(
      configPath,
      `import { defineOperatorConfig, schnorrAccountFromEnv } from '${join(PKG_ROOT, 'src/ts/operator/config.ts')}';\n` +
        `export default defineOperatorConfig(schnorrAccountFromEnv());\n`,
    );
    // No node is running at this URL, so it fails after key parsing.
    const result = run(['policy', '--fpc', `0x${'1'.repeat(64)}`, '--show', '--config-module', configPath], {
      ACCOUNT_SECRET_KEY: SECRET_KEY,
      ACCOUNT_SALT: '0x1',
      ACCOUNT_SIGNING_KEY: SIGNING_KEY,
      NODE_URL: 'http://127.0.0.1:1',
      QUOTA_CLI_DEBUG: '1',
    });
    expect(result.status).not.toBe(0);
    expect(result.combined).not.toContain(SECRET_KEY);
    expect(result.combined).not.toContain(SIGNING_KEY);
  });

  test('the journal — not the terminal — is where a claim secret lives', () => {
    // Sanity on the documented contract: no command prints a secret, and the
    // claim path reads it from the journal by default.
    const help = run(['claim', '--help']).stdout;
    expect(help).toMatch(/journal/i);
    expect(help).toMatch(/NEVER accepted on argv/i);
  });
});

describe('published CLI: malformed input is a REFUSAL, not a crash', () => {
  // Exit 2 means "nothing happened". A native BigInt/JSON throw escaping as
  // exit 1 would tell an operator the run failed operationally, which reads as
  // "it might have done something".
  test('a non-numeric --amount-wei refuses with exit 2', () => {
    const result = run([
      'bridge',
      '--to',
      `0x${'1'.repeat(64)}`,
      '--amount-wei',
      'nope',
      '--config-module',
      poisonConfig(),
    ]);
    expect(result.status).toBe(2);
    expect(result.combined).toMatch(/--amount-wei must be an integer/);
    expect(result.combined).not.toMatch(/CONFIG_FACTORY_RAN/);
  });

  test('a non-numeric --max-loss-wei refuses with exit 2', () => {
    const result = run([
      'policy',
      '--fpc',
      `0x${'1'.repeat(64)}`,
      '--max-uses',
      '3',
      '--max-loss-wei',
      'lots',
      '--config-module',
      poisonConfig(),
    ]);
    expect(result.status).toBe(2);
  });

  test('policy bounds match the contract: 0 and overflow are refused up front', () => {
    // The contract asserts max_uses/max_users >= 1 and stores u32; catching it
    // here means the operator is not asked to confirm a plan that must revert.
    for (const args of [
      ['--max-uses', '0'],
      ['--max-users', '0'],
      ['--max-uses', '4294967296'],
      ['--max-fee-wei', '0'],
    ]) {
      const result = run([
        'policy',
        '--fpc',
        `0x${'1'.repeat(64)}`,
        ...args,
        '--max-loss-wei',
        '1',
        '--config-module',
        poisonConfig(),
      ]);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.combined, args.join(' ')).toMatch(/must be an integer in|must not be negative/);
      expect(result.combined).not.toMatch(/CONFIG_FACTORY_RAN/);
    }
  });

  test('malformed --config JSON refuses with exit 2 (as deploy already did)', () => {
    const dir = tempDir('quota-bin-badjson-');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    const result = run([
      'policy',
      '--fpc',
      `0x${'1'.repeat(64)}`,
      '--max-uses',
      '3',
      '--config',
      bad,
      '--config-module',
      poisonConfig(),
    ]);
    expect(result.status).toBe(2);
    expect(result.combined).toMatch(/not valid JSON/);
  });

  test('--cancel cannot be combined with edit flags (it would do something else)', () => {
    const result = run([
      'policy',
      '--fpc',
      `0x${'1'.repeat(64)}`,
      '--cancel',
      '--max-uses',
      '3',
      '--max-loss-wei',
      '1',
      '--config-module',
      poisonConfig(),
    ]);
    expect(result.status).toBe(2);
    expect(result.combined).toMatch(/--cancel restores the live policy/);
    expect(result.combined).not.toMatch(/CONFIG_FACTORY_RAN/);
  });

  test('bridge refuses a zero amount and an absurd gas buffer up front', () => {
    for (const args of [
      ['--amount-wei', '0'],
      ['--amount-wei', '1', '--gas-limit-buffer-percent', '99999'],
      // Above the u128 the fee-juice claim accepts: the L1 portal would take
      // the deposit and no L2 claim could ever redeem it.
      ['--amount-wei', (2n ** 128n).toString()],
    ]) {
      const result = run(['bridge', '--to', `0x${'1'.repeat(64)}`, ...args, '--config-module', poisonConfig()]);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.combined).not.toMatch(/CONFIG_FACTORY_RAN/);
    }
  });

  test('a malformed address is a USAGE refusal, not an operational failure', () => {
    for (const args of [
      ['policy', '--fpc', '0xnothex'],
      ['measure', '--fpc', `0x${'1'.repeat(64)}`, '--target', '0xshort', '--artifact', 'x.json', '--method', 'm'],
      ['claim', '--for', '0x1'],
    ]) {
      const result = run([...args, '--config-module', poisonConfig()]);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.combined).toMatch(/must be an Aztec address/);
      expect(result.combined).not.toMatch(/CONFIG_FACTORY_RAN/);
    }
  });

  test('a throwing dispose() warns but does NOT become the command outcome', () => {
    // The refusal here is bridge's "no l1 in the context" (exit 2). Before the
    // fix, dispose's throw replaced it and the CLI reported exit 1 — which for
    // a SUCCESSFUL bridge would mean printing success and then failing, an
    // invitation to deposit twice.
    // INSIDE the package: a config module's own imports resolve from ITS
    // location, so one written to a temp dir cannot resolve @aztec/*.
    const path = join(PKG_ROOT, `.tmp-dispose-${process.pid}.config.mjs`);
    cleanups.push(() => rmSync(path, { force: true }));
    // The context must VALIDATE, so that the refusal happens inside
    // withContext — which is where the dispose under test runs.
    writeFileSync(
      path,
      [
        `import { defineOperatorConfig } from './src/ts/operator/config.js';`,
        `import { AztecAddress } from '@aztec/aztec.js/addresses';`,
        `export default defineOperatorConfig(async () => ({`,
        `  node: { getNodeInfo: async () => ({ l1ChainId: 1, rollupVersion: 1 }) },`,
        `  wallet: { getChainInfo: async () => ({ chainId: 1n, version: 1n }) },`,
        // Below the BN254 modulus, or AztecAddress refuses it.
        `  from: AztecAddress.fromStringUnsafe('0x0${'a'.repeat(63)}'),`,
        `  dispose: () => { throw new Error('DISPOSE_BOOM'); },`,
        `}));`,
      ].join('\n'),
    );
    const result = run(['bridge', '--to', `0x${'1'.repeat(64)}`, '--amount-wei', '1', '--config-module', path]);
    expect(result.status).toBe(2);
    expect(result.combined).toMatch(/has no `l1.client`/);
    expect(result.combined).toMatch(/dispose\(\) threw: DISPOSE_BOOM/);
  });

  test('a malformed piped secret is NEVER echoed back', () => {
    // Fr's own error embeds the string it was given, and main.ts prints
    // error.message — so an unguarded parse put the secret into terminal
    // scrollback and CI logs, the exact exposure --secret-stdin prevents.
    const secret = 'my-super-secret-claim-preimage-typo';
    // A config that LOADS, so the claim actually reaches the parse; a poison
    // config would make this test pass without exercising anything.
    const path = join(PKG_ROOT, `.tmp-secret-${process.pid}.config.mjs`);
    cleanups.push(() => rmSync(path, { force: true }));
    writeFileSync(
      path,
      [
        `import { defineOperatorConfig } from './src/ts/operator/config.js';`,
        `import { AztecAddress } from '@aztec/aztec.js/addresses';`,
        `export default defineOperatorConfig(async () => ({`,
        `  node: { getNodeInfo: async () => ({ l1ChainId: 1, rollupVersion: 1 }) },`,
        `  wallet: { getChainInfo: async () => ({ chainId: 1n, version: 1n }) },`,
        `  from: AztecAddress.fromStringUnsafe('0x0${'a'.repeat(63)}'),`,
        `}));`,
      ].join('\n'),
    );
    const result = run(
      [
        'claim',
        '--for',
        `0x0${'1'.repeat(63)}`,
        '--secret-stdin',
        '--amount-wei',
        '1',
        '--leaf-index',
        '0',
        '--config-module',
        path,
      ],
      {},
      secret,
    );
    expect(result.combined).not.toContain(secret);
    // ...and prove the parse was actually reached, so this cannot pass
    // vacuously if the code path moves.
    expect(result.combined).toMatch(/Value withheld from this message on purpose/);
  });

  test('a manual claim with impossible numbers is refused before the config module runs', () => {
    for (const args of [
      ['--amount-wei', '0', '--leaf-index', '1'],
      ['--amount-wei', '1', '--leaf-index', (2n ** 36n).toString()],
    ]) {
      const result = run([
        'claim',
        '--for',
        `0x${'1'.repeat(64)}`,
        '--secret-stdin',
        ...args,
        '--config-module',
        poisonConfig(),
      ]);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.combined).not.toMatch(/CONFIG_FACTORY_RAN/);
    }
  });

  test('a positional argument is refused WITHOUT echoing it', () => {
    // A mistyped `--secret x` lands the secret in the positional slot; the
    // refusal must not copy it into logs.
    const result = run(['policy', 'supersecretvalue']);
    expect(result.status).toBe(2);
    expect(result.combined).toMatch(/unexpected positional argument/);
    expect(result.combined).not.toContain('supersecretvalue');
  });
});

describe('published CLI: the gas profile is always explicit', () => {
  test('a policy edit without any gas profile refuses and names both ways to supply one', () => {
    // No silent fallback to a reference profile: a foreign envelope can approve
    // a ceiling that stops sponsorship for the real application. The check
    // consults ctx.gasProfile, so it necessarily runs AFTER the config loads —
    // hence a minimal working config here rather than the poison one. It still
    // never reaches the network: the refusal precedes every chain read.
    const dir = tempDir('quota-bin-nogas-');
    const configPath = join(dir, 'nogas.config.mjs');
    writeFileSync(
      configPath,
      `export default { __quotaPaymasterConfig: true, load: async () => ` +
        `({ node: {}, wallet: {}, from: { toString: () => '0x1' } }) };`,
    );
    const result = run([
      'policy',
      '--fpc',
      `0x${'1'.repeat(64)}`,
      '--max-uses',
      '3',
      '--max-loss-wei',
      '1',
      '--config-module',
      configPath,
    ]);
    expect(result.status).toBe(2);
    expect(result.combined).toMatch(/gas profile is required/);
    expect(result.combined).toMatch(/--gas-profile/);
  });

  test('help no longer advertises --config-module as optional', () => {
    const help = run(['deploy', '--help']).stdout;
    expect(help).toMatch(/--config-module <path>/);
    expect(help).not.toMatch(/\[--config-module/);
  });
});

describe('published CLI: source and packaging agree', () => {
  test('the bin launcher points at the compiled CLI entry', () => {
    const launcher = readFileSync(join(PKG_ROOT, 'bin/quota-paymaster.mjs'), 'utf8');
    expect(launcher).toMatch(/dist\/src\/ts\/cli\/main\.js/);
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
    expect(pkg.bin['quota-paymaster']).toBe('bin/quota-paymaster.mjs');
    expect(pkg.files).toContain('bin');
  });
});
