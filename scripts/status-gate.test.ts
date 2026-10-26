import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The package workflows' `<Name> Status` jobs are what main's ruleset requires. A required check
// that reads `skipped` passes, so each status job must never skip, must see every other job, and
// must fail exactly when one of them failed or was cancelled.

const WORKFLOWS = join(import.meta.dir, '..', '.github', 'workflows');
const STATUS_JOBS: Record<string, string> = {
  'private-fee-juice.yml': 'Private Fee Juice Status',
  'quota-paymaster.yml': 'Quota Paymaster Status',
  'aztec-benchmark.yml': 'Aztec Benchmark Status',
};
// Required by name, so each name must belong to exactly one job in the repository.
const REQUIRED = [...Object.values(STATUS_JOBS), 'Biome + manifests + tooling tests', 'Lint workflows'];
const FAIL_WHEN = "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')";

type Step = { if?: string; run?: string; 'continue-on-error'?: unknown };
type Job = { name?: string; if?: string; needs?: string | string[]; steps?: Step[] };

const jobsOf = (file: string) =>
  (Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as { jobs: Record<string, Job> }).jobs;
const needsOf = (job: Job | undefined) => [job?.needs ?? []].flat();

describe.each(Object.entries(STATUS_JOBS))('%s', (file, name) => {
  const { status, ...others } = jobsOf(file);

  test('the status job always runs and needs every other job', () => {
    expect(status?.name).toBe(name);
    expect(status?.if).toBe('always()');
    expect(needsOf(status).sort()).toEqual(Object.keys(others).sort());
  });

  test('its one step fails when a needed job failed or was cancelled, and only then', () => {
    expect(status?.steps).toHaveLength(1);
    const step = status?.steps?.[0];
    expect(step?.if).toBe(FAIL_WHEN);
    expect(step?.run?.trim().endsWith('exit 1')).toBe(true);
    expect(step?.['continue-on-error']).toBeUndefined();
  });

  test('every job another job needs is unconditional', () => {
    // A job skipped by its own condition skips its dependents too, and status accepts both skips;
    // only failures and cancels propagate, and those it rejects. The status job's own needs are
    // exactly the conditional jobs, so its edges are exempt.
    for (const dependency of Object.values(others).flatMap(needsOf)) {
      expect({ dependency, if: others[dependency]?.if }).toEqual({ dependency, if: undefined });
    }
  });
});

test('each required check names exactly one job across all workflows', () => {
  const names = readdirSync(WORKFLOWS)
    .filter((file) => file.endsWith('.yml'))
    .flatMap((file) => Object.values(jobsOf(file)).map((job) => job.name));
  for (const required of REQUIRED) {
    expect({ required, jobs: names.filter((n) => n === required).length }).toEqual({ required, jobs: 1 });
  }
});
