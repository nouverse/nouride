/**
 * Snapshots of `nouride.db`, and the way back from one.
 *
 * The only item on the open list whose loss cannot be undone. Persona packs have been copied daily
 * since `@nouride/persona`'s `backup.ts` was written; the database has not, and it now holds the
 * conversations, the turn records, usage, the audit log, the daemon's own log, cron jobs and their
 * runs, approvals, sender access, grants and skill drafts — 26 MB in one file on the live box. The
 * `.db.bak-*` files there were made by hand, twice, both times because somebody was about to do
 * something risky.
 *
 * ## Why not `cp`
 *
 * Because it looks like it works. The live database is one of three files: everything committed
 * since the last checkpoint is in `nouride.db-wal`, so a copy of the main file alone is the
 * database as of some arbitrary earlier moment — and it opens without complaint. That is the worst
 * available failure shape: a backup that exists, restores cleanly, and is silently behind.
 *
 * `VACUUM INTO` is SQLite's answer. One file, consistent, compacted, no sidecars, and it opens as an
 * ordinary database — so recovery is a `cp` back, by a person at three in the morning who has never
 * read this file. Same reasoning as the pack backups being a directory of copies rather than an
 * archive.
 *
 * ## Every snapshot is verified
 *
 * `quick_check` on the *copy*, not on the original. A backup nobody has opened is a hope, and the
 * whole point of taking one is the case where the original has gone bad — if the corruption came
 * along for the ride, the operator needs to know now, while an older good snapshot may still exist,
 * not during a restore. A snapshot that fails its check is deleted and logged loudly: keeping it
 * would let the retention rule rotate a good one away in favour of a broken one.
 */

import {
  checkDatabaseFile,
  ensureDir,
  fileExistsSync,
  freeDiskBytes,
  join,
  listDir,
  openDatabase,
  removePath,
  renamePath,
  restrictDatabaseFiles,
  statFile,
  type SqliteDb,
} from "@nouride/runtime";
import { rotateDatabaseEpoch } from "./epoch.ts";
import { createLogger, formatBytes, snapshotStamp, snapshotTakenAt } from "@nouride/shared";

const log = createLogger("db.backup");

/** Where snapshots go, under `data/` so they land on the volume every deployment shape mounts. */
const DIR = ["backups", "db"];

const PREFIX = "nouride-";
const SUFFIX = ".db";

/**
 * What names a snapshot taken because the schema was about to change — `nouride-<stamp>-before-048.db`.
 *
 * Kept outside the weekly rotation, and only the newest one: it is the way back from an upgrade that
 * has to be undone (`db/index.ts:newerThanThisBuild`), and a rotation of four boot snapshots would
 * otherwise push it out after four restarts — fewer, at a lower `backup_keep` — which a crash loop
 * on the new version reaches in under a minute.
 */
const BEFORE = "-before-";

export interface DbBackupResult {
  /** The file written, or null when nothing was written. */
  path: string | null;
  bytes: number;
  /** Older snapshots dropped by the retention rule. */
  removed: number;
  /** Set when nothing was written, in the words an operator should see. */
  error?: string;
}

export function dbBackupDir(dataDir: string): string {
  return join(dataDir, ...DIR);
}

/** Sortable, and sorting is how the sweep decides what is oldest — the one stamp every backup writes. */
const stamp = snapshotStamp;

/**
 * Take one snapshot, verify it, and drop the oldest.
 *
 * Never throws. A backup that fails must not take the daemon down: the failure it protects against
 * is rarer than the daemon being useful, and an operator who finds no snapshot has lost less than
 * one who finds no daemon. The result says what happened either way, because this is also called
 * from a CLI command where the person is waiting for an answer.
 */
export function backupDatabase(input: {
  db: SqliteDb;
  dataDir: string;
  /** The backups directory — `commons/backup-dir.ts`. Absent means `<dataDir>/backups`. */
  backupDir?: string;
  keep: number;
  now?: () => number;
  /** Free bytes where the snapshot goes — `freeDiskBytes`; replaced in tests. */
  freeBytes?: (dir: string) => number | null;
}): DbBackupResult {
  const now = (input.now ?? Date.now)();
  const root = input.backupDir ? join(input.backupDir, "db") : dbBackupDir(input.dataDir);
  const written = writeSnapshot(input.db, join(root, `${PREFIX}${stamp(now)}${SUFFIX}`), input.freeBytes);
  if (written.path === null) return written;
  const removed = sweep(root, input.keep);
  log.info("database backed up", { path: written.path, bytes: written.bytes, removed });
  return { ...written, removed };
}

/**
 * The snapshot taken just before migrations are applied to an existing database — never throws.
 *
 * `version` is the migration about to run, so the name says what it is the way back from. The previous
 * one of these is removed once this one checks out: one upgrade's worth of undo is what anybody uses.
 */
export function backupBeforeMigration(input: { db: SqliteDb; dataDir: string; version: number; now?: () => number }): DbBackupResult {
  const now = (input.now ?? Date.now)();
  const root = dbBackupDir(input.dataDir);
  const name = `${PREFIX}${stamp(now)}${BEFORE}${String(input.version).padStart(3, "0")}${SUFFIX}`;
  const written = writeSnapshot(input.db, join(root, name));
  if (written.path === null) return written;
  const older = listDir(root).filter((entry) => !entry.isDirectory && entry.name.includes(BEFORE) && entry.name !== name);
  for (const entry of older) removePath(join(root, entry.name));
  log.info("database backed up before migrating", { path: written.path, bytes: written.bytes, migration: input.version });
  return { ...written, removed: older.length };
}

/** Write, verify and keep one snapshot at `target`. Never throws: the result says what happened. */
function writeSnapshot(db: SqliteDb, target: string, freeBytes: (dir: string) => number | null = freeDiskBytes): DbBackupResult {
  const root = join(target, "..");
  try {
    ensureDir(root);

    /**
     * Room for it twice over, or no snapshot.
     *
     * `VACUUM INTO` writes the whole database again — its pages less the free ones — and on a nearly full card it ran
     * until the disk was full, failed, and deleted what it had written: in between, every write the daemon made failed
     * too, a turn, a log line, the inbox. Twice the size leaves the live database as much room as the copy takes.
     * Unknown free space (a filesystem that does not say) is not a refusal.
     */
    const { pages, free, pageSize } = db.pageStats();
    const needed = 2 * (pages - free) * pageSize;
    const available = freeBytes(root);
    if (available !== null && available < needed) {
      const error = `not enough free space for a snapshot: ${formatBytes(available)} free where it goes, and it needs ${formatBytes(needed)} (twice the database, so the copy cannot fill the disk under it)`;
      log.error("database not backed up", { reason: error });
      return { path: null, bytes: 0, removed: 0, error };
    }

    /**
     * Written under a partial name and renamed on success.
     *
     * A snapshot interrupted half-written — the disk filling is the likely one — must not be left
     * looking like a snapshot. Under its final name the retention rule would count it, and a
     * restore would find it and use it.
     */
    const partial = `${target}.partial`;
    removePath(partial);
    db.backupTo(partial);

    const verdict = verify(partial);
    if (!verdict.ok) {
      removePath(partial);
      log.error("the backup just taken does not check out, so it was discarded", {
        detail: verdict.detail,
      });
      return { path: null, bytes: 0, removed: 0, error: `the copy failed its integrity check: ${verdict.detail}` };
    }

    renamePath(partial, target);
    /**
     * `0600`, because a snapshot is the database.
     *
     * `VACUUM INTO` creates the file under the process umask, which on the live box left it
     * world-readable at 0644 beside a database deliberately kept at 0600 — every conversation, the
     * audit log with full tool arguments, and the dashboard's password hashes, readable by any local
     * account. Caught by looking at `ls -la` on the box after the first snapshot, not by a test.
     */
    restrictDatabaseFiles(target);
    return { path: target, bytes: statFile(target)?.size ?? 0, removed: 0 };
  } catch (err) {
    log.error("could not back up the database", { error: String(err) });
    return { path: null, bytes: 0, removed: 0, error: String(err instanceof Error ? err.message : err) };
  }
}

/**
 * Ask a snapshot whether it is intact, read-only.
 *
 * Read-only is the whole point, and getting it wrong is instructive: the first version opened the
 * snapshot through `openDatabase`, which sets `PRAGMA journal_mode = WAL` — a write to the header —
 * created two sidecars, and then had to delete them again to keep the one-file property. Every
 * snapshot it checked came back unreadable on the *second* check. A verification step that can
 * damage the thing it verifies is worse than no verification at all, so this cannot write.
 */
export function verify(path: string): { ok: boolean; detail: string } {
  return checkDatabaseFile(path);
}

/**
 * Newest first, which is the order a person picking one to restore wants.
 *
 * From `<dataDir>/backups/db` and, when one is configured, `<backupDir>/db` as one list: the snapshots
 * taken before a migration always live in the first, and the way back from an upgrade is exactly when
 * somebody looks.
 */
export function listBackups(dataDir: string, backupDir?: string): { name: string; path: string; bytes: number; at: number }[] {
  const roots = [...new Set([dbBackupDir(dataDir), ...(backupDir ? [join(backupDir, "db")] : [])])];
  return roots
    .filter((root) => statFile(root))
    .flatMap((root) =>
      listDir(root)
        .filter((entry) => !entry.isDirectory && entry.name.startsWith(PREFIX) && entry.name.endsWith(SUFFIX))
        .map((entry) => {
          const path = join(root, entry.name);
          const stat = statFile(path);
          return { name: entry.name, path, bytes: stat?.size ?? 0, at: stat?.mtimeMs ?? 0 };
        }),
    )
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * When the newest snapshot was taken, read from its name — or null when there is none.
 *
 * The name and not the mtime, for the reason `sweep` gives: a restored filesystem rewrites mtimes, and
 * the stamp is what this directory's chronology is built on. UTC, as `stamp` wrote it.
 */
export function newestBackupAt(dataDir: string, backupDir?: string): number | null {
  for (const backup of listBackups(dataDir, backupDir)) {
    const at = takenAt(backup.name);
    if (at !== null) return at;
  }
  return null;
}

/** When a snapshot was taken, from the stamp in its name, to the second; null for a name without one. */
export function takenAt(name: string): number | null {
  return snapshotTakenAt(name, "nouride-");
}

/**
 * Keep the newest `keep` snapshots.
 *
 * By name, which sorts chronologically because the stamp was built to. Reading mtimes would be the
 * obvious alternative and is the wrong one: an mtime changes when a filesystem is itself restored
 * from a backup, so a rule keyed on it either wipes the restored archive or never fires again.
 */
function sweep(root: string, keep: number): number {
  if (keep <= 0) return 0;

  const names = listDir(root)
    .filter((entry) => !entry.isDirectory && entry.name.startsWith(PREFIX) && entry.name.endsWith(SUFFIX) && !entry.name.includes(BEFORE))
    .map((entry) => entry.name)
    .sort();

  const doomed = names.slice(0, Math.max(0, names.length - keep));
  for (const name of doomed) removePath(join(root, name));
  return doomed.length;
}

export type RestoreOutcome =
  | { ok: true; from: string; replaced: string | null }
  | { ok: false; error: string };

/**
 * Put a snapshot back, with the daemon stopped.
 *
 * **The caller has to have stopped the daemon.** This does not check, because it cannot: a lock
 * file is advisory and a stale one from a killed process would refuse a restore at exactly the
 * moment somebody needs it most. `cli/commands/db.ts` asks whether the pid in the lock file is a
 * live Nouride, which is the same question `gateway rename` asks and for the same reasons.
 *
 * Writing this found that the adapter's `close()` did not actually close: `bun:sqlite` releases the
 * handle lazily without `close(true)`, so the file's mapping outlived the call and a rename-then-open
 * failed with `SQLiteError: disk I/O error` — a message that reads like corruption and is not.
 * Anything that only reads afterwards never noticed. See the note on `close` in `runtime/db.ts`.
 *
 * Three things in order, and the order is the whole design:
 *
 * 1. **The snapshot is verified before anything is touched.** Restoring a broken file over a working
 *    one is a way to turn one problem into two.
 * 2. **The current database is moved aside, not deleted.** Named `.replaced-<stamp>`, so a restore
 *    from the wrong snapshot is itself undoable. The most likely mistake here is picking yesterday
 *    when you wanted this morning, and it is only recoverable if the wrong choice kept the evidence.
 * 3. **The sidecars are moved with it, not deleted.** Two failures in one step, and the first
 *    version of this had both. A `-wal` *left in place* belongs to the old database and SQLite
 *    replays it over the restored file, producing a mixture of two databases rather than either
 *    one. A `-wal` *deleted* takes everything committed since the last checkpoint with it — so the
 *    file kept aside for the undo is unopenable, which was caught by testing the undo rather than
 *    the restore. Moved, so the set aside is a complete database and nothing is left behind.
 */
export function restoreDatabase(input: {
  from: string;
  dbPath: string;
  now?: () => number;
}): RestoreOutcome {
  const now = (input.now ?? Date.now)();

  if (!fileExistsSync(input.from)) return { ok: false, error: `no such snapshot: ${input.from}` };

  const verdict = verify(input.from);
  if (!verdict.ok) {
    return { ok: false, error: `that snapshot does not check out, so nothing was changed: ${verdict.detail}` };
  }

  try {
    let replaced: string | null = null;
    if (fileExistsSync(input.dbPath)) {
      replaced = `${input.dbPath}.replaced-${stamp(now)}`;
      renamePath(input.dbPath, replaced);
      /**
       * The sidecars follow it under the matching names, so what is set aside is a database and not
       * two thirds of one.
       *
       * Deleting them instead is the obvious shortcut and it loses every row committed since the
       * last checkpoint — on a busy daemon that is the most recent conversation. Found by asserting
       * the *undo* worked, not the restore.
       */
      for (const suffix of ["-wal", "-shm"]) {
        if (fileExistsSync(`${input.dbPath}${suffix}`)) {
          renamePath(`${input.dbPath}${suffix}`, `${replaced}${suffix}`);
        }
      }
    }
    // Nothing may be left under the daemon's own name: a stray sidecar here belongs to the database
    // that just moved, and SQLite would replay it over the file about to be restored.
    for (const suffix of ["-wal", "-shm"]) removePath(`${input.dbPath}${suffix}`);

    // Copied by opening the snapshot and vacuuming it into place, rather than a file copy: it lands
    // as a fresh single file with the sidecars it will create at first open, and a half-written copy
    // cannot be left under the daemon's own filename.
    const source = openDatabase(input.from);
    try {
      source.backupTo(input.dbPath);
    } finally {
      source.close();
      /**
       * The snapshot is left as it was found: one file.
       *
       * `openDatabase` converts it to WAL mode to read it, which creates these two — and a snapshot
       * that has grown sidecars is no longer the thing whose recovery is a `cp`. Cleaned up here
       * rather than avoided, because the copy back genuinely needs a write-capable handle.
       */
      for (const suffix of ["-wal", "-shm"]) removePath(`${input.from}${suffix}`);
    }

    // An older life of the database: its next rows reuse numbers a follower of the stream holds past (`epoch.ts`).
    rotateDatabaseEpoch(input.dbPath);
    log.info("database restored", { from: input.from, replaced });
    return { ok: true, from: input.from, replaced };
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
}
