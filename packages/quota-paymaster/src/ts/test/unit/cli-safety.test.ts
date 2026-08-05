/**
 * The repo-local CLI's safety rails, exercised as a real subprocess — the
 * refusals only matter if they hold at the actual process boundary.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const CLI = new URL('../../../../scripts/cli.ts', import.meta.url).pathname;

function run(args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync('bun', [CLI, ...args], { stdio: 'pipe', encoding: 'utf8' });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('cli safety', () => {
  test('a claim secret on argv is REFUSED loudly, before anything else runs', () => {
    const { status, output } = run(['claim', '--for', '0xabc', '--secret', '0xdeadbeef']);
    expect(status).not.toBe(0);
    expect(output).toMatch(/REFUSED/);
    expect(output).toMatch(/shell history/);
  });

  test('the refusal applies to every subcommand, not just claim', () => {
    const { status, output } = run(['bridge', '--to', '0xabc', '--secret', '0x01']);
    expect(status).not.toBe(0);
    expect(output).toMatch(/REFUSED/);
  });

  test('--help exits 0 for every subcommand without touching a network', () => {
    for (const cmd of ['deploy', 'policy', 'bridge', 'claim', 'measure']) {
      const { status, output } = run([cmd, '--help']);
      expect(status, `${cmd} --help`).toBe(0);
      expect(output.length).toBeGreaterThan(10);
    }
    expect(run(['--help']).status).toBe(0);
  });

  test('an unknown command names itself and exits non-zero', () => {
    const { status, output } = run(['withdraw']);
    expect(status).not.toBe(0);
    expect(output).toMatch(/unknown command withdraw/);
  });
});
