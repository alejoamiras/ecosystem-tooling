/**
 * The hardened bridge journal: every failure mode the audits demanded a test
 * for. These tests use real files in a temp dir — the hardening IS filesystem
 * behavior, so mocking fs would test nothing.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  appendJournalRecord,
  BRIDGE_JOURNAL_FILE,
  backdateLockForTests,
  closeJournalDir,
  type JournalHandle,
  openJournalDir,
  readJournalRecords,
  withJournalLock,
} from '../../operator/internal/journal.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'quota-journal-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openTemp(): { dir: string; handle: JournalHandle } {
  const dir = join(tempDir(), 'journal');
  const handle = openJournalDir(dir);
  cleanups.push(() => closeJournalDir(handle));
  return { dir, handle };
}

const record = (state: string, extra: Record<string, unknown> = {}) => ({
  state,
  at: new Date().toISOString(),
  ...extra,
});

describe('journal directory', () => {
  test('is created 0700 and accepted', () => {
    const { handle } = openTemp();
    expect(handle.dirFd).toBeGreaterThan(0);
  });

  test('a group/world-readable directory is refused — it holds claim secrets', () => {
    const dir = join(tempDir(), 'loose');
    mkdirSync(dir, { mode: 0o755 });
    expect(() => openJournalDir(dir)).toThrow(/group\/world accessible/);
  });

  test('a symlinked journal file is refused (O_NOFOLLOW), not silently followed', () => {
    const { dir, handle } = openTemp();
    const outside = join(tempDir(), 'attacker-target');
    writeFileSync(outside, '');
    symlinkSync(outside, join(dir, BRIDGE_JOURNAL_FILE));
    expect(() => appendJournalRecord(handle, BRIDGE_JOURNAL_FILE, record('SECRET_GENERATED'))).toThrow(
      /ELOOP|symlink/i,
    );
  });
});

describe('append + read roundtrip', () => {
  test('appended records come back intact and 0600', () => {
    const { dir, handle } = openTemp();
    appendJournalRecord(handle, BRIDGE_JOURNAL_FILE, record('SECRET_GENERATED', { claimSecret: '0xaa' }));
    appendJournalRecord(handle, BRIDGE_JOURNAL_FILE, record('DEPOSIT_CONFIRMED', { messageHash: '0xbb' }));
    const { records, tornLines } = readJournalRecords(handle, BRIDGE_JOURNAL_FILE);
    expect(tornLines).toBe(0);
    expect(records.map((r) => r.state)).toEqual(['SECRET_GENERATED', 'DEPOSIT_CONFIRMED']);
    // Verify the mode was re-asserted on the file.
    expect(statSync(join(dir, BRIDGE_JOURNAL_FILE)).mode & 0o777).toBe(0o600);
  });

  test('a torn trailing line (crash mid-append) is REPORTED, never silently skipped', () => {
    const { dir, handle } = openTemp();
    appendJournalRecord(handle, BRIDGE_JOURNAL_FILE, record('SECRET_GENERATED'));
    // Simulate the crash: a truncated JSON line at the tail.
    writeFileSync(join(dir, BRIDGE_JOURNAL_FILE), '{"state":"DEPOSIT_CONF', { flag: 'a', mode: 0o600 });
    const { records, tornLines } = readJournalRecords(handle, BRIDGE_JOURNAL_FILE);
    expect(records).toHaveLength(1);
    expect(tornLines).toBe(1);
  });

  test('a pre-existing loose-mode journal file is tightened to 0600 on append', () => {
    const { dir, handle } = openTemp();
    const file = join(dir, BRIDGE_JOURNAL_FILE);
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    appendJournalRecord(handle, BRIDGE_JOURNAL_FILE, record('SECRET_GENERATED'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('locking', () => {
  test('serializes: a held lock makes the second taker wait (and time out)', async () => {
    const { handle } = openTemp();
    await withJournalLock(handle, async () => {
      await expect(withJournalLock(handle, async () => 'should not run', { timeoutMs: 400 })).rejects.toThrow(
        /held by another operator/,
      );
    });
  });

  test('a crashed holder is detected by age and stolen loudly', async () => {
    const { handle } = openTemp();
    const warnings: string[] = [];
    // Take the lock and DO NOT release (simulated crash): re-enter bypassing fn.
    await withJournalLock(handle, () => {
      backdateLockForTests(handle, 10 * 60_000);
      // While "crashed", a new taker must steal rather than hang.
      return withJournalLock(handle, async () => 'ran', {
        timeoutMs: 2_000,
        onWarn: (m) => warnings.push(m),
      });
    });
    expect(warnings.some((w) => /stealing stale journal lock/.test(w))).toBe(true);
  });

  test('the lock is released after the critical section, even on throw', async () => {
    const { handle } = openTemp();
    await expect(
      withJournalLock(handle, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Releasable again immediately:
    await withJournalLock(handle, async () => {}, { timeoutMs: 300 });
  });
});
