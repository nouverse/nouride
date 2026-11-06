/**
 * The database file holds every conversation, the audit log with full tool arguments, and
 * (from Phase 3) dashboard credentials. Found world-readable on a real data directory:
 *
 *   -rw-------  data/.control-token
 *   -rw-------  data/secrets.json
 *   -rw-r--r--  data/nouride.db          ← and -wal, -shm
 *
 * The two files we create ourselves were tight; the one SQLite creates was not, because it
 * inherits the umask. On a shared host that is every local account able to read the lot.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, rmSync, statSync, mkdtempSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { checkDatabaseFile, databaseVersion, openDatabase, queryDatabaseFile, restrictDatabaseFiles } from "../src/db.ts";

const TEST_DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-db-mode-"));
const DB_PATH = join(TEST_DIR, "test.db");

const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8);

describe("database file permissions", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  test("openDatabase leaves the file owner-only", () => {
    const db = openDatabase(DB_PATH);
    try {
      expect(mode(DB_PATH)).toBe("600");
    } finally {
      db.close();
    }
  });

  test("the WAL sidecars are owner-only too", () => {
    // They are created by SQLite on first write, not by us, so they inherit the umask
    // independently. Tightening only the main file would leave the write-ahead log —
    // which holds the same rows — readable.
    const db = openDatabase(DB_PATH);
    try {
      db.exec("CREATE TABLE t (v TEXT)");
      db.prepare("INSERT INTO t VALUES (?)").run("a conversation nobody else should read");
      restrictDatabaseFiles(DB_PATH);

      expect(mode(`${DB_PATH}-wal`)).toBe("600");
      expect(mode(`${DB_PATH}-shm`)).toBe("600");
    } finally {
      db.close();
    }
  });

  test("a missing sidecar is not an error", () => {
    // Called on a path whose -wal does not exist yet, and on filesystems without POSIX
    // modes. Neither is a reason to refuse to start.
    expect(() => restrictDatabaseFiles(join(TEST_DIR, "absent.db"))).not.toThrow();
  });
});

/**
 * The write-ahead log on flash (E3/E4, 2026-10-15).
 *
 * Asking the log's size used to *be* a checkpoint — `wal_checkpoint(PASSIVE)` reports the frame count
 * as a side effect of doing one — and `/health` asks every ten seconds while the dashboard is open. So
 * every write reached the database file within ten seconds instead of coalescing in the log.
 */
describe("the write-ahead log", () => {
  const LOG_DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-wal-"));
  const LOG_DB = join(LOG_DIR, "wal.db");

  beforeEach(() => {
    rmSync(LOG_DIR, { recursive: true, force: true });
    mkdirSync(LOG_DIR, { recursive: true });
  });

  afterEach(() => rmSync(LOG_DIR, { recursive: true, force: true }));

  /** Enough rows that a checkpoint has new pages to copy into the database file. */
  function written(): ReturnType<typeof openDatabase> {
    const db = openDatabase(LOG_DB);
    db.exec("CREATE TABLE t (v TEXT)");
    const insert = db.prepare("INSERT INTO t VALUES (?)");
    db.transaction(() => {
      for (let i = 0; i < 200; i += 1) insert.run("x".repeat(1_000));
    });
    return db;
  }

  test("reading its size moves nothing into the database file", () => {
    const db = written();
    try {
      const before = statSync(LOG_DB).size;
      const reported = db.walSizeBytes();
      // What the file says, and the database file untouched by the asking: the property that was lost.
      expect(reported).toBe(statSync(`${LOG_DB}-wal`).size);
      expect(reported).toBeGreaterThan(0);
      expect(statSync(LOG_DB).size).toBe(before);

      // …while an actual checkpoint does move them, so the assertion above can tell the two apart.
      expect(db.checkpoint("PASSIVE").checkpointed).toBeGreaterThan(0);
      expect(statSync(LOG_DB).size).toBeGreaterThan(before);
    } finally {
      db.close();
    }
  });

  test("TRUNCATE gives the log's disk back", () => {
    const db = written();
    try {
      expect(db.walSizeBytes()).toBeGreaterThan(0);
      expect(db.checkpoint("TRUNCATE").busy).toBe(false);
      expect(db.walSizeBytes()).toBe(0);
    } finally {
      db.close();
    }
  });

  test("autocheckpoint at 2000 pages, and a size limit so a burst does not stay on disk", () => {
    const db = openDatabase(LOG_DB);
    try {
      expect(db.prepare<{ wal_autocheckpoint: number }>("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint).toBe(2000);
      expect(db.prepare<{ journal_size_limit: number }>("PRAGMA journal_size_limit").get()?.journal_size_limit).toBe(8 * 1024 * 1024);
    } finally {
      db.close();
    }
  });

  test("its page cache is held to 16 MB — the largest cache an idle daemon keeps", () => {
    // Up to 14 MB of a box's anonymous memory once its database is past 16 MB (`memory-growth-since-0-6`), and the
    // figure SYSTEM_REQUIREMENTS names. A negative cache_size is KiB; a positive one would be pages.
    const db = openDatabase(LOG_DB);
    try {
      expect(db.prepare<{ cache_size: number }>("PRAGMA cache_size").get()?.cache_size).toBe(-16_000);
    } finally {
      db.close();
    }
  });
});

/**
 * `nouride db verify` on the live database, while the daemon writes it. A lock held for a moment answered "database is
 * locked" — reported as a database that does not check out, to someone deciding whether to restore.
 */
describe("checking a database file", () => {
  test("waits out a lock another process holds, rather than calling the file bad", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-db-check-"));
    try {
      const path = join(dir, "live.db");
      const setup = new Database(path);
      setup.exec("CREATE TABLE t (x INTEGER)");
      setup.close();
      // A rollback journal, so a writer's exclusive lock shuts readers out — the window a WAL checkpoint also opens.
      const holder = Bun.spawn(
        [process.execPath, "-e", `
          const { Database } = require("bun:sqlite");
          const db = new Database(${JSON.stringify(path)});
          db.exec("BEGIN EXCLUSIVE; INSERT INTO t VALUES (1)");
          console.log("locked");
          setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);
        `],
        { stdout: "pipe" },
      );
      const reader = holder.stdout.getReader();
      let said = "";
      while (!said.includes("locked")) said += new TextDecoder().decode((await reader.read()).value);
      expect(checkDatabaseFile(path)).toEqual({ ok: true, detail: "ok" });
      await holder.exited;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a database's schema, as `nouride db restore` reads it of a snapshot", () => {
  test("is its user_version, read without a write: no WAL switch, no sidecar left beside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-db-version-"));
    try {
      const path = join(dir, "old.db");
      // A database in rollback-journal mode, as one from before 0.7 can be: opened to write, it would be made WAL.
      const old = new Database(path);
      old.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY); PRAGMA user_version = 44");
      old.close();
      expect(databaseVersion(path)).toBe(44);
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);
      const after = new Database(path, { readonly: true });
      expect((after.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file that is not a database, or no file, is null — not a throw, and not a 0 read as a schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-db-version-"));
    try {
      writeFileSync(join(dir, "text.db"), "not a database at all, just text that is long enough to have a header");
      expect(databaseVersion(join(dir, "text.db"))).toBeNull();
      expect(databaseVersion(join(dir, "absent.db"))).toBeNull();
      expect(existsSync(join(dir, "absent.db"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rows read off a database file, as `nouride doctor` reads the daemon's", () => {
  test("are read without a write: no WAL switch, no sidecar, and no file made where there was none", () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-db-query-"));
    try {
      const path = join(dir, "kept.db");
      const kept = new Database(path);
      kept.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO notes (text) VALUES ('kept')");
      kept.close();
      expect(queryDatabaseFile<{ text: string }>(path, "SELECT text FROM notes WHERE id = ?", 1)).toEqual([{ text: "kept" }]);
      expect(existsSync(`${path}-wal`)).toBe(false);
      const after = new Database(path, { readonly: true });
      expect((after.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
      after.close();

      expect(queryDatabaseFile(join(dir, "absent.db"), "SELECT 1")).toBeNull();
      expect(existsSync(join(dir, "absent.db"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a query the file cannot answer, a table its schema has not got yet, is null rather than a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-db-query-"));
    try {
      const path = join(dir, "older.db");
      new Database(path).close();
      expect(queryDatabaseFile(path, "SELECT value FROM daemon_state WHERE name = ?", "advisories")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("opening a database another process holds for a moment", () => {
  test("waits for it, rather than calling the file unreadable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-busy-"));
    const path = join(dir, "busy.db");
    try {
      const setup = new Database(path);
      setup.exec("PRAGMA journal_mode = WAL");
      setup.exec("CREATE TABLE t (a)");
      setup.close();
      // Another process takes the file whole for a moment, as a start-up's recovery or a checkpoint can: sixteen CLIs
      // opening one database at once had 13 of 320 told it was not a database (2026-11-04).
      const holder = spawn(process.execPath, [
        "-e",
        `const { Database } = require("bun:sqlite");
         const db = new Database(${JSON.stringify(path)});
         db.exec("PRAGMA locking_mode = EXCLUSIVE");
         db.exec("BEGIN EXCLUSIVE");
         db.exec("INSERT INTO t VALUES (1)");
         console.log("held");
         setTimeout(() => { db.exec("COMMIT"); db.close(); }, 700);`,
      ]);
      const exited = new Promise((resolve) => holder.on("exit", resolve));
      await new Promise((resolve) => holder.stdout.once("data", resolve));
      const db = openDatabase(path);
      expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
      db.close();
      await exited;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
