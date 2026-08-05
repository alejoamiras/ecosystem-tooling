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
import { randomBytes } from 'node:crypto';
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
 * Runs `fn` holding the journal's exclusive lock.
 *
 * The lock is a file created with O_EXCL carrying an OWNER TOKEN (pid + a
 * random nonce). Review hardening (post-impl correctness pass):
 *  - The holder HEARTBEATS the lock's mtime while inside `fn`, so a
 *    legitimately slow critical section (a bridge waits on two mined L1
 *    transactions) never goes "stale" — staleness now really means crashed.
 *  - Steal and release are IDENTITY-CHECKED: a lock is only unlinked when its
 *    content matches the token the remover observed/wrote, so A finishing late
 *    cannot release B's lock, and two stealers cannot both proceed (one loses
 *    the O_EXCL re-create and re-queues).
 *  - Lock-file creation failures close the fd and remove the partial file; a
 *    persistently failing steal sleeps and re-checks the timeout instead of
 *    spinning forever.
 * A residual TOCTOU remains on the STEAL and RELEASE paths (Node core has no
 * flock): both are read-check-unlink, so two stealers observing the same
 * crashed lock can interleave such that one unlinks the OTHER's freshly
 * created successor, letting both proceed (post-impl audit finding #6). Two
 * mitigations bound it: the heartbeat makes false staleness effectively
 * impossible (entering the window requires a genuinely crashed holder PLUS
 * two stealers racing within milliseconds), and every acquirer re-verifies
 * its own token is still in the lock file after a short settle delay,
 * catching the interleaving before any journal write happens. Not a proof —
 * an unlucky third stealer during the settle window is still unguarded — but
 * the journal's appends are the guarded operations and they are idempotent
 * at the record level (append-only, readers dedup by state).
 */
export async function withJournalLock<T>(
  handle: JournalHandle,
  fn: () => Promise<T> | T,
  opts: { timeoutMs?: number; onWarn?: (msg: string) => void } = {},
): Promise<T> {
  const lockPath = join(handle.dirPath, LOCK_FILE);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const started = Date.now();
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`;

  const readLockToken = (): string | undefined => {
    try {
      return readFileSync(lockPath, 'utf8');
    } catch {
      return undefined;
    }
  };

  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        writeSync(fd, Buffer.from(token));
      } catch (err) {
        // ENOSPC etc.: never leave a zero-byte lock blocking everyone.
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          /* best effort */
        }
        throw err;
      }
      closeSync(fd);
      // Post-acquire re-verify: let concurrent stealers' unlink window pass,
      // then confirm the lock still carries OUR token. If a racing stealer
      // unlinked our fresh lock and created its own, we lose and re-queue
      // instead of entering the critical section concurrently (finding #6).
      await new Promise((r) => setTimeout(r, 25));
      if (readLockToken() !== token) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(`journal lock ${lockPath} lost to a concurrent stealer; timed out`);
        }
        continue;
      }
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err;
      let stale = false;
      const observed = readLockToken();
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
      } catch {
        continue; // lock vanished between EEXIST and stat — retry immediately
      }
      if (stale && observed !== undefined) {
        opts.onWarn?.(`stealing stale journal lock ${lockPath} (holder presumed crashed)`);
        try {
          // Identity-checked steal: only remove the exact lock we observed as
          // stale — if the content changed, a fresh holder took it; re-queue.
          if (readLockToken() === observed) unlinkSync(lockPath);
        } catch {
          // Removal failed (already gone, or persistent fs error): fall
          // through to the timeout-checked sleep rather than spinning.
        }
        // Fall through: re-attempt via O_EXCL; a losing concurrent stealer
        // simply sees EEXIST again.
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`journal lock ${lockPath} held by another operator process; timed out`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Heartbeat: a live holder is never stale, no matter how slow L1 is.
  const heartbeat = setInterval(() => {
    try {
      if (readLockToken() === token) {
        const now = Date.now() / 1000;
        const hfd = openSync(lockPath, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
          futimesSync(hfd, now, now);
        } finally {
          closeSync(hfd);
        }
      }
    } catch {
      /* heartbeat is best-effort; the identity checks are the safety net */
    }
  }, STALE_LOCK_MS / 4);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      // Identity-checked release: never unlink a lock that is no longer ours.
      if (readLockToken() === token) unlinkSync(lockPath);
    } catch {
      // Already removed — nothing to release.
    }
  }
}

/**
 * Node has no true openat: file opens resolve BY PATH. Before every such open,
 * assert the path still resolves to the SAME directory inode the handle holds —
 * a parent-symlink rotation after openJournalDir would otherwise send secrets
 * to a replacement directory while the old FD gets the fsync (post-impl audit
 * finding #5). dev+ino equality binds path resolution to the held descriptor.
 */
function assertDirUnmoved(handle: JournalHandle): void {
  const held = fstatSync(handle.dirFd);
  const atPath = statSync(handle.dirPath);
  if (held.dev !== atPath.dev || held.ino !== atPath.ino) {
    throw new Error(
      `journal directory ${handle.dirPath} no longer resolves to the directory this handle ` +
        `opened (rotated or replaced); refusing to touch secrets through it`,
    );
  }
}

/**
 * Appends one record and does not return until the bytes AND the directory
 * entry are durably on disk. All checks act on descriptors, never paths.
 */
export function appendJournalRecord(handle: JournalHandle, file: string, record: JournalRecord): void {
  assertDirUnmoved(handle);
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
    assertDirUnmoved(handle);
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
