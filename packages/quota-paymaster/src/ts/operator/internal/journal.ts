/**
 * The bridge journal: the only durable home of claim secrets.
 *
 * A claim secret is the ONE unrecoverable piece of a bridge deposit — lose it
 * and the deposit is destroyed for everyone, forever. So the journal is written
 * with the paranoia that implies, hardened per the extraction plan's audits:
 *
 *  - An OWNED 0700 directory (default `~/.quota-paymaster/`), never a
 *    caller-supplied arbitrary file path. Outside any repository, so no git
 *    operation can ever pick a secret up.
 *  - Directory-descriptor discipline: the directory is opened ONCE
 *    (O_DIRECTORY|O_NOFOLLOW), ownership/mode-checked on the DESCRIPTOR, and
 *    that same descriptor is fsynced after each append — a rotation or symlink
 *    swap between path-based operations cannot redirect the durability
 *    guarantee.
 *  - O_NOFOLLOW on every file open, fstat-on-descriptor checks (regular file,
 *    owned by us), unconditional fchmod 0600 (a pre-existing file keeps 0600
 *    even though open() mode only applies at creation).
 *  - A lock file serializes concurrent operator invocations — two bridges
 *    interleaving appends could corrupt each other's records.
 *  - Short writes are looped, the file is fsynced, THEN the directory.
 *  - Secrets never travel via argv or stdout; they live in records here and in
 *    process memory only.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  futimesSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface JournalHandle {
  readonly dirPath: string;
  readonly dirFd: number;
}

export interface JournalRecord {
  state: string;
  at: string;
  [key: string]: unknown;
}

export const DEFAULT_JOURNAL_DIR = () => join(homedir(), '.quota-paymaster');
export const BRIDGE_JOURNAL_FILE = 'bridge-journal.jsonl';
const LOCK_FILE = 'journal.lock';
/** A lock older than this is presumed crashed and is stolen (with a warning). */
const STALE_LOCK_MS = 120_000;

/**
 * Opens (creating if needed) the owned journal directory and verifies it on
 * the DESCRIPTOR: a directory, owned by this uid, no group/other permissions.
 */
export function openJournalDir(dirPath: string = DEFAULT_JOURNAL_DIR()): JournalHandle {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const dirFd = openSync(dirPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(dirFd);
    if (!st.isDirectory()) throw new Error(`${dirPath} is not a directory`);
    if (process.getuid && st.uid !== process.getuid()) {
      throw new Error(`journal dir ${dirPath} is not owned by this user; refusing`);
    }
    if ((st.mode & 0o077) !== 0) {
      throw new Error(
        `journal dir ${dirPath} is group/world accessible (mode ${(st.mode & 0o777).toString(8)}); ` +
          `chmod 700 it — it holds claim secrets`,
      );
    }
  } catch (err) {
    closeSync(dirFd);
    throw err;
  }
  return { dirPath, dirFd };
}

export function closeJournalDir(handle: JournalHandle): void {
  closeSync(handle.dirFd);
}

/**
 * Runs `fn` holding the journal's exclusive lock. The lock is a file created
 * with O_EXCL; a holder that crashed is detected by age and stolen loudly.
 */
export async function withJournalLock<T>(
  handle: JournalHandle,
  fn: () => Promise<T> | T,
  opts: { timeoutMs?: number; onWarn?: (msg: string) => void } = {},
): Promise<T> {
  const lockPath = join(handle.dirPath, LOCK_FILE);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      writeSync(fd, Buffer.from(String(process.pid)));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
      } catch {
        continue; // lock vanished between EEXIST and stat — retry immediately
      }
      if (stale) {
        opts.onWarn?.(`stealing stale journal lock ${lockPath} (holder presumed crashed)`);
        try {
          unlinkSync(lockPath);
        } catch {
          // Someone else stole it first; loop and race for the fresh lock.
        }
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`journal lock ${lockPath} held by another operator process; timed out`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already removed (stolen after a long pause) — nothing to release.
    }
  }
}

/**
 * Appends one record and does not return until the bytes AND the directory
 * entry are durably on disk. All checks act on descriptors, never paths.
 */
export function appendJournalRecord(handle: JournalHandle, file: string, record: JournalRecord): void {
  const buf = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  const fd = openSync(
    join(handle.dirPath, file),
    constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`journal ${file} is not a regular file; refusing to write a secret to it`);
    }
    if (process.getuid && st.uid !== process.getuid()) {
      throw new Error(`journal ${file} is not owned by this user; refusing`);
    }
    // open()'s mode applies only at creation; a pre-existing file keeps
    // whatever it had, so re-assert on the descriptor.
    fchmodSync(fd, 0o600);
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // The held directory descriptor, not a fresh path-based open: the entry we
  // just made durable is in THIS directory, whatever the path points at now.
  fsyncSync(handle.dirFd);
}

/**
 * Reads all records. Torn trailing lines (a crash mid-append) are reported,
 * not silently skipped — a truncated record that LOOKS absent hides evidence.
 */
export function readJournalRecords(
  handle: JournalHandle,
  file: string,
): { records: JournalRecord[]; tornLines: number } {
  let fd: number;
  try {
    fd = openSync(join(handle.dirPath, file), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { records: [], tornLines: 0 };
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`journal ${file} is not a regular file`);
    const lines = readFileSync(fd, 'utf8').split('\n').filter(Boolean);
    const records: JournalRecord[] = [];
    let tornLines = 0;
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as JournalRecord);
      } catch {
        tornLines += 1;
      }
    }
    return { records, tornLines };
  } finally {
    closeSync(fd);
  }
}

/** Test hook: backdate the lock file so staleness paths are exercisable. */
export function backdateLockForTests(handle: JournalHandle, ageMs: number): void {
  const when = (Date.now() - ageMs) / 1000;
  const lockPath = join(handle.dirPath, LOCK_FILE);
  const fd = openSync(lockPath, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    futimesSync(fd, when, when);
  } finally {
    closeSync(fd);
  }
}
