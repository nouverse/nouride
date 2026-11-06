/**
 * SQLite adapter over `bun:sqlite` (TD-001, TD-005).
 *
 * The `bun:sqlite` `Database` type deliberately does not leak past this module —
 * business logic depends on `SqliteDb` below, which is the subset we actually use
 * and which any other driver could satisfy.
 */

import { Database } from "bun:sqlite";
import { setFileMode, statFile } from "./fs.ts";

/** SQLite's page cache per connection, in KiB — 16 MB where SQLite's default is 2 MB. See `openDatabase`. */
const PAGE_CACHE_KIB = 16_000;

export interface SqliteStatement<T> {
  all(...params: unknown[]): T[];
  get(...params: unknown[]): T | null;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare<T = Record<string, unknown>>(sql: string): SqliteStatement<T>;
  /** Wraps `fn` in a transaction — a savepoint when one is already open. Returns the value `fn` returned. */
  transaction<T>(fn: () => T): T;
  /** Whether a transaction is open on this connection. */
  inTransaction(): boolean;
  userVersion(): number;
  setUserVersion(version: number): void;
  /**
   * `PRAGMA application_id` — the file format's *other* spare integer.
   *
   * SQLite provides it for exactly one purpose: letting a tool tell whether a database it has been
   * handed belongs to it. Nouride uses it to answer a narrower version of the same question — are
   * the migrations that were applied to this file the ones this binary carries? See
   * `db/index.ts:schemaFingerprint`.
   *
   * 0 means unset, which is both SQLite's default and how an install from before this existed is
   * recognised.
   */
  applicationId(): number;
  setApplicationId(id: number): void;
  /**
   * Bytes in the write-ahead log file — what `/health` watches (§15.2 SPEC).
   *
   * Read off the file, never by checkpointing. It used to be the frame count a `wal_checkpoint(PASSIVE)`
   * reported, so asking the size *was* a checkpoint — and the dashboard's Home page asks every ten
   * seconds, the CLI on every command. With a tab open every write was copied into the database file
   * within ten seconds instead of coalescing in the log, and on an SD card each of those is a write
   * the card did not need (E3, 2026-10-15).
   *
   * The file keeps its size after a checkpoint — SQLite rewinds the log rather than shrinking it — so
   * this is the high-water mark since the last reset, bounded by `journal_size_limit`. Past the health
   * threshold it means checkpoints are not completing, which is the thing worth an alarm.
   */
  walSizeBytes(): number;
  /**
   * Move the log into the database file. `PASSIVE` copies what it can without waiting for anyone;
   * `TRUNCATE` waits for readers, then empties the log file to zero bytes.
   *
   * Explicit and rare: SQLite's own autocheckpoint does the ordinary work as the log grows, and the
   * one caller of this is the nightly pass, at an hour when nothing else is writing.
   */
  checkpoint(mode: "PASSIVE" | "TRUNCATE"): { busy: boolean; log: number; checkpointed: number };
  /**
   * `PRAGMA integrity_check`, or the error it raised.
   *
   * Run once at boot. A corrupt page is silent until something reads it, which for a conversation
   * store means the failure surfaces weeks later as a turn that dies for no visible reason —
   * long after the backup that would have fixed it was rotated away.
   */
  integrityCheck(): { ok: boolean; detail: string };
  /**
   * Write a consistent copy of the whole database to `path`.
   *
   * `VACUUM INTO`, which is the only correct way to do this while the daemon is running. Copying
   * the file with `cp` looks like it works and does not: the live file is one of three, and
   * everything committed since the last checkpoint is in the `-wal` sidecar. A copy taken without
   * it is the database as of some arbitrary earlier moment, and it restores without complaint —
   * which is the worst failure shape available, a backup that exists and is silently behind.
   *
   * The result is a single file with no sidecars, already compacted, that opens as an ordinary
   * database. Recovery is therefore a `cp` back, with no tool and no knowledge of this code.
   *
   * Here rather than in a store because it is SQLite's own statement and `path` is a filesystem
   * path, not a row: a store would be a store of nothing.
   */
  backupTo(path: string): void;
  /** The SQLite inside this process and what was compiled into it — what boot checks before migrating. */
  sqliteInfo(): { version: string; compileOptions: string[] };
  /** Pages in the file, how many are free, and how big a page is. */
  pageStats(): { pages: number; free: number; pageSize: number };
  /**
   * Rebuild the file without its free pages, then give the log's disk back too.
   *
   * In WAL mode the rebuilt pages land in the `-wal` file, and a checkpoint is what moves them home —
   * without `TRUNCATE` the log keeps its high-water size on disk until the next one. Atomic: a VACUUM
   * that fails (no disk, a busy lock) leaves the file exactly as it was.
   */
  vacuum(): void;
  /**
   * Rows inserted, updated or deleted through this connection since it was opened — SQLite's own count
   * (`total_changes()`). The daemon has one connection, so an unchanged count is a database nothing wrote to.
   */
  totalChanges(): number;
  /** `PRAGMA optimize`: refresh the planner's statistics where they have gone stale. Cheap when they have not. */
  optimize(): void;
  close(): void;
}

/**
 * Open (creating if absent) the database at `path`.
 *
 * WAL mode is the reason a single file is enough for this daemon: readers — the
 * dashboard, the health check — never block the writer, and the writer never
 * blocks them. `busy_timeout` covers the one case WAL does not, two writers
 * arriving at once, by waiting instead of throwing SQLITE_BUSY.
 */
export function openDatabase(path: string): SqliteDb {
  let db: Database;
  try {
    db = new Database(path, { create: true });
    // Before anything that takes a lock. Switching to WAL reads the file's header, and a process that opened it while
    // another was starting it up or checkpointing met that lock with no wait, and was told below that the file was
    // not a database: sixteen CLIs opening one database at once had 13 of 320 refused so (2026-11-04).
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
  } catch (err) {
    // Held for longer than the wait: busy, not broken, and nothing about the file needs moving aside.
    if (/database is locked|SQLITE_BUSY/i.test(String(err))) {
      throw new Error(`cannot open the database at ${path}: another process has held it locked for more than five seconds. Nothing is wrong with the file; try again.`, { cause: err });
    }
    // A file too damaged to open throws here, *before* `integrityCheck` can report on it — found
    // while testing that check against a non-database file. Raw, this surfaces as a `SQLiteError`
    // stack trace at boot, which tells an operator nothing about what to do. It is not recoverable in
    // process, so the one useful thing is to name the file and the fix.
    throw new Error(
      `cannot open the database at ${path}: ${String(err)}\n` +
        `The file is unreadable or not a database. Restore it from a backup, or move it aside to ` +
        `start fresh (the conversations in it will be lost).`,
      { cause: err },
    );
  }
  // Tightened after the WAL sidecars exist, so all three get the same mode.
  //
  // The default umask leaves these world-readable, and this file holds every conversation, the
  // audit log with full tool arguments, and (from Phase 3) dashboard password hashes. On a
  // shared host that is every local account able to read the lot. Best-effort: a filesystem
  // without POSIX modes is not a reason to refuse to start.
  restrictDatabaseFiles(path);
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  /**
   * A 16 MB page cache where SQLite's default is 2 MB, and sorts kept off the disk.
   *
   * The cache fills only as pages are read, so a small database never costs the whole 16 MB. In memory,
   * temporary B-trees also stop depending on a writable temp directory, which a hardened unit
   * (`ProtectSystem=strict`) mostly does not have. No `mmap_size`: on a memory-mapped file an I/O error
   * arrives as a signal and kills the process — on an SD-card box, a recoverable error traded for a
   * dead daemon.
   *
   * The largest cache an idle daemon keeps, and resident: on a box whose database is past 16 MB it fills with use and
   * stays, which is about 14 MB of the anonymous memory a 2 MB cache never held (`memory-growth-since-0-6`; the figure is
   * in SYSTEM_REQUIREMENTS.md). `db.test.ts` holds it here.
   */
  db.exec(`PRAGMA cache_size = -${PAGE_CACHE_KIB}`);
  db.exec("PRAGMA temp_store = MEMORY");
  /**
   * The log's two bounds, chosen for the flash it lives on (E4, 2026-10-15).
   *
   * `wal_autocheckpoint = 2000` pages — 8 MB at the default page size, twice SQLite's default. A
   * checkpoint copies each page once however many times the log rewrote it, so a longer log folds more
   * of the same rows into one write to the database file: a session updated every turn, an index page
   * every insert touches, the turn record flushed while a reply streams.
   *
   * `journal_size_limit` is what gives the disk back. Without it a log that one burst grew to 200 MB
   * stayed 200 MB until a `VACUUM` — the only thing that truncated it — and the health check read it as
   * a WAL that would not stop growing.
   */
  db.exec("PRAGMA wal_autocheckpoint = 2000");
  db.exec("PRAGMA journal_size_limit = 8388608");

  return {
    exec: (sql) => db.exec(sql),
    prepare: <T>(sql: string) => db.prepare(sql) as unknown as SqliteStatement<T>,
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    inTransaction: () => db.inTransaction,
    userVersion: () => {
      const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | null;
      return row?.user_version ?? 0;
    },
    // Interpolated because PRAGMA does not accept bound parameters. Callers are
    // migration code passing an integer literal, never user input.
    setUserVersion: (version) => db.exec(`PRAGMA user_version = ${Math.trunc(version)}`),
    applicationId: () => {
      const row = db.prepare("PRAGMA application_id").get() as { application_id: number } | null;
      return row?.application_id ?? 0;
    },
    // Same interpolation, same reason. Truncated to a signed 32-bit integer because that is what
    // the header field is — a larger number is stored modulo that and would compare unequal to
    // itself on the next boot.
    setApplicationId: (id) => db.exec(`PRAGMA application_id = ${id | 0}`),
    // `:memory:` has no file, and a missing `-wal` is an empty log: both read as zero.
    walSizeBytes: () => statFile(`${path}-wal`)?.size ?? 0,
    checkpoint: (mode) => {
      // Interpolated from a closed union: PRAGMA takes no bound parameters, and nothing else reaches here.
      const row = db.prepare(`PRAGMA wal_checkpoint(${mode === "TRUNCATE" ? "TRUNCATE" : "PASSIVE"})`).get() as
        | { busy: number; log: number; checkpointed: number }
        | null;
      return { busy: (row?.busy ?? 0) !== 0, log: row?.log ?? 0, checkpointed: row?.checkpointed ?? 0 };
    },
    integrityCheck: () => {
      try {
        // `quick_check` rather than the full scan: it catches structural corruption in a fraction of
        // the time, and a boot that stalls for a minute on a large database would just get skipped.
        const row = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | null;
        const value = row ? String(Object.values(row)[0] ?? "") : "";
        return { ok: value === "ok", detail: value || "no result" };
      } catch (err) {
        // A throw here *is* the finding: an unreadable database cannot report on itself.
        return { ok: false, detail: String(err) };
      }
    },
    backupTo: (target) => {
      // Interpolated because VACUUM INTO takes no bound parameter, with the quote doubled — the
      // path comes from config and a directory with an apostrophe in it is a real directory.
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    },
    sqliteInfo: () => ({
      version: (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v,
      compileOptions: (db.prepare("PRAGMA compile_options").all() as { compile_options: string }[]).map((row) => row.compile_options),
    }),
    pageStats: () => ({
      pages: (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count,
      free: (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
      pageSize: (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size,
    }),
    vacuum: () => {
      db.exec("VACUUM");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    optimize: () => db.exec("PRAGMA optimize"),
    totalChanges: () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n,
    /**
     * `close(true)`, not `close()`.
     *
     * Without the argument the handle is released lazily — the call returns, and the memory mapping
     * of the file and its WAL survives until a garbage collection. Everything that only *reads*
     * afterwards is unaffected, which is why this went unnoticed; anything that **moves the file**
     * then fails to reopen it with `SQLiteError: disk I/O error`, a message that reads like
     * corruption and is not.
     *
     * Found while restoring a snapshot, which renames the live database aside and puts a copy in its
     * place. It matters for `gateway rename` on the same grounds, and for any future path that
     * treats the database as a file after closing it.
     */
    close: () => db.close(true),
  };
}

/**
 * Integrity-check a database file **without opening it for writing**.
 *
 * For checking a *backup*, which `openDatabase` cannot safely do: that one sets
 * `PRAGMA journal_mode = WAL`, which is a write to the file's header and creates two sidecars
 * beside it. So the act of verifying a snapshot changed it, and left it needing cleanup that then
 * had to be right — a verification step that can damage the thing it verifies is worse than none.
 *
 * Read-only means none of that is possible: no mode change, no sidecars, no cleanup, and a snapshot
 * stays the single file that makes recovery a `cp`.
 *
 * A throw is the finding. A file too damaged to open cannot report on itself.
 */
export function checkDatabaseFile(path: string): { ok: boolean; detail: string } {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    // The live database is checked while the daemon writes it: a lock held for a moment is waited out, not reported as
    // a database that "does not check out".
    db.exec("PRAGMA busy_timeout = 5000");
    const row = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | null;
    const value = row ? String(Object.values(row)[0] ?? "") : "";
    return { ok: value === "ok", detail: value || "no result" };
  } catch (err) {
    return { ok: false, detail: String(err instanceof Error ? err.message : err) };
  } finally {
    db?.close();
  }
}

/**
 * `0600` on the database and its WAL sidecars.
 *
 * `-wal` and `-shm` are created by SQLite, not by us, so they inherit the umask independently —
 * tightening only the main file would leave the write-ahead log, which contains the same rows,
 * readable.
 */
export function restrictDatabaseFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    setFileMode(`${path}${suffix}`, 0o600);
  }
}

/**
 * A database file's schema version — its `user_version` — read **without opening it for writing**, as
 * `checkDatabaseFile` reads and for the same reason: `nouride db restore` asks it of a snapshot before it is put back,
 * and must change nothing — no mode switch, no sidecars. Null when the file cannot be read as a database.
 */
export function databaseVersion(path: string): number | null {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | null;
    return typeof row?.user_version === "number" ? row.user_version : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Rows read off a database file **without opening it for writing**, as `databaseVersion` reads its version: for a
 * command that runs whether or not the daemon holds the file (`nouride doctor`), which must change nothing. No mode
 * switch, no sidecars, and no database made where there was none. Null when the file cannot be read as a database, or
 * the query fails on it: a table its schema does not have yet.
 */
export function queryDatabaseFile<T>(path: string, sql: string, ...params: unknown[]): T[] | null {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return (db.prepare(sql) as unknown as SqliteStatement<T>).all(...params);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
