/**
 * What a connection from `openDatabase` is set to, and what its helpers answer.
 *
 * `db.test.ts` covers file modes, the write-ahead log and reading a file's schema. The 0.7.11 mutation sweep found
 * every PRAGMA the connection is opened with deletable without a test noticing — `foreign_keys` among them, which is
 * the one between a deleted row and the rows that point at it — and four helpers no test called: the integrity check
 * on a live connection, the backup the daemon takes before a migration, `VACUUM`, and the application id.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { checkDatabaseFile, openDatabase } from "../src/db.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-db-conn-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pragma = (db: ReturnType<typeof openDatabase>, name: string) =>
  Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];

describe("opening", () => {
  test("sets what it says it sets", () => {
    const db = openDatabase(join(dir, "a.db"));
    try {
      expect({
        journal: pragma(db, "journal_mode"),
        synchronous: pragma(db, "synchronous"),
        foreignKeys: pragma(db, "foreign_keys"),
        busyTimeout: pragma(db, "busy_timeout"),
        cacheSize: pragma(db, "cache_size"),
        tempStore: pragma(db, "temp_store"),
      }).toEqual({ journal: "wal", synchronous: 1, foreignKeys: 1, busyTimeout: 5000, cacheSize: -16000, tempStore: 2 });
    } finally {
      db.close();
    }
  });

  test("a file that is not a database is refused with what to do about it", () => {
    const path = join(dir, "junk.db");
    writeFileSync(path, "this is not a database, and it is long enough that SQLite reads its header".repeat(20));
    expect(() => openDatabase(path)).toThrow(`cannot open the database at ${path}`);
  });
});

describe("the helpers", () => {
  test("the application id is what was set", () => {
    const db = openDatabase(join(dir, "a.db"));
    try {
      db.setApplicationId(0x4e52);
      expect(db.applicationId()).toBe(0x4e52);
    } finally {
      db.close();
    }
  });

  test("a sound connection checks ok, and one that cannot be checked is not ok", () => {
    const db = openDatabase(join(dir, "a.db"));
    expect(db.integrityCheck()).toEqual({ ok: true, detail: "ok" });
    db.close();
    expect(db.integrityCheck().ok).toBe(false);
  });

  test("a checkpoint says what it moved", () => {
    const db = openDatabase(join(dir, "a.db"));
    try {
      db.exec("CREATE TABLE t (v TEXT)");
      db.exec("INSERT INTO t VALUES ('x')");
      const passive = db.checkpoint("PASSIVE");
      expect(passive.busy).toBe(false);
      expect(passive.log).toBeGreaterThan(0);
      expect(passive.checkpointed).toBe(passive.log);
      expect(db.checkpoint("TRUNCATE")).toEqual({ busy: false, log: 0, checkpointed: 0 });
    } finally {
      db.close();
    }
  });

  test("a backup is a database holding the rows, at a path with quotes in it", () => {
    const db = openDatabase(join(dir, "a.db"));
    const target = join(dir, "it's the owner's backup.db");
    try {
      db.exec("CREATE TABLE t (v TEXT)");
      db.exec("INSERT INTO t VALUES ('kept')");
      db.backupTo(target);
    } finally {
      db.close();
    }
    const copy = new Database(target, { readonly: true });
    try {
      expect(copy.prepare("SELECT v FROM t").all()).toEqual([{ v: "kept" }]);
    } finally {
      copy.close();
    }
  });

  test("VACUUM gives back the pages that deleted rows held, and leaves no log behind", () => {
    const db = openDatabase(join(dir, "a.db"));
    try {
      db.exec("CREATE TABLE t (v TEXT)");
      db.transaction(() => {
        for (let i = 0; i < 2000; i += 1) db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(200));
      });
      db.exec("DELETE FROM t");
      db.checkpoint("TRUNCATE");
      expect(db.pageStats().free).toBeGreaterThan(0);
      db.vacuum();
      expect(db.pageStats().free).toBe(0);
      expect(db.walSizeBytes()).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("checking a file", () => {
  test("a file that is not a database is not ok, and says why in words", () => {
    const path = join(dir, "junk.db");
    writeFileSync(path, "not a database at all ".repeat(50));
    const result = checkDatabaseFile(path);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not a database|malformed|file is encrypted/i);
    // The message, not the error's class in front of it.
    expect(result.detail).not.toMatch(/^\w*Error/);
    expect(existsSync(`${path}-wal`)).toBe(false);
  });
});
