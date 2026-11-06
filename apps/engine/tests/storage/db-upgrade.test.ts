/**
 * What a boot does to a database it is newer than — the whole of an upgrade, since `nouride update
 * --start` only swaps the binary and restarts: refuse a SQLite that cannot hold the schema, snapshot
 * an existing database before changing it, and compact the file once a migration has emptied most of it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import { backupDatabase, listBackups } from "@/db/backup.ts";
import { compactIfMostlyFree, missingCapabilities, openAndMigrate, schemaFingerprint, sqliteCapabilities } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { tempDir } from "../helpers.ts";

let dir: string;

beforeEach(() => {
  dir = tempDir("db-upgrade");
});

afterEach(() => {
  removePath(dir);
});

describe("the SQLite underneath", () => {
  test("names what an old or FTS5-less SQLite lacks, and passes one that has both", () => {
    expect(missingCapabilities({ version: "3.39.5", compileOptions: ["ENABLE_FTS5"] })).toEqual([
      "SQLite 3.39.5: needs 3.43 or later (FTS5 contentless_delete)",
    ]);
    expect(missingCapabilities({ version: "3.53.2", compileOptions: ["ENABLE_JSON1"] })).toEqual(["FTS5: not compiled in"]);
    expect(missingCapabilities({ version: "3.43.0", compileOptions: ["ENABLE_FTS5"] })).toEqual([]);
    expect(missingCapabilities({ version: "4.0.0", compileOptions: ["ENABLE_FTS5"] })).toEqual([]);
  });

  test("the one this suite runs on has both — so every release target's check is exercised for real", () => {
    expect(sqliteCapabilities().missing).toEqual([]);
  });
});

/** The schema this build leaves. */
const LATEST = MIGRATIONS.at(-1)!.version;
const NEXT_NAME = String(LATEST + 1).padStart(3, "0");

/**
 * The next migration, which this build does not have yet: an upgrade is a database as this build leaves it meeting a
 * manifest with one more entry, so that is what these pass — the upgrade path every 0.8.x will take.
 */
const NEXT = [...MIGRATIONS, { version: LATEST + 1, name: `${NEXT_NAME}_next.sql`, sql: "CREATE TABLE next_table (id INTEGER PRIMARY KEY);" }];

/** A database as this build leaves it, with a row in it — the one the next release upgrades. */
async function thisRelease(path: string): Promise<void> {
  const db = await openAndMigrate(path);
  db.exec(`INSERT INTO sessions (id, agent_id, chat_id, gateway, created_at, updated_at) VALUES ('ses_1', 'nouva', '1', 'telegram:main', 1, 2)`);
  db.close();
}

describe("a snapshot before migrating", () => {
  test("an existing database is snapshotted before the new migration, under a name that says so", async () => {
    const path = join(dir, "nouride.db");
    await thisRelease(path);
    const db = await openAndMigrate(path, NEXT);
    expect(db.userVersion()).toBe(LATEST + 1);
    expect(db.applicationId()).toBe(schemaFingerprint(NEXT, LATEST + 1));
    expect(db.prepare<{ id: string }>("SELECT id FROM sessions").all()).toEqual([{ id: "ses_1" }]);
    db.close();

    const before = listBackups(dir).filter((backup) => backup.name.includes("-before-"));
    expect(before.map((backup) => backup.name)).toEqual([expect.stringMatching(new RegExp(`^nouride-[\\d-]+-before-${NEXT_NAME}\\.db$`))]);
    // The snapshot is the database as it was: still where this build left it.
    const snapshot = openDatabase(before[0]!.path);
    expect(snapshot.userVersion()).toBe(LATEST);
    snapshot.close();
  });

  test("survives the weekly rotation, however small `backup_keep` is", async () => {
    const path = join(dir, "nouride.db");
    await thisRelease(path);
    const db = await openAndMigrate(path, NEXT);
    let now = Date.UTC(2030, 0, 1);
    for (let i = 0; i < 4; i++) backupDatabase({ db, dataDir: dir, keep: 1, now: () => (now += 1000) });
    db.close();
    const names = listBackups(dir).map((backup) => backup.name);
    expect(names.filter((name) => name.includes("-before-"))).toHaveLength(1);
    expect(names.filter((name) => !name.includes("-before-"))).toHaveLength(1);
  });

  test("a fresh database has nothing to lose, so nothing is written", async () => {
    const db = await openAndMigrate(join(dir, "nouride.db"), NEXT);
    db.close();
    expect(listBackups(dir)).toEqual([]);
  });
});

describe("compacting after a migration", () => {
  let db: SqliteDb;

  beforeEach(() => {
    db = openDatabase(join(dir, "compact.db"));
    db.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE kept (id INTEGER PRIMARY KEY, body TEXT)");
    db.transaction(() => {
      const big = db.prepare("INSERT INTO big (body) VALUES (?)");
      const kept = db.prepare("INSERT INTO kept (body) VALUES (?)");
      for (let i = 0; i < 3000; i++) big.run("x".repeat(400));
      for (let i = 0; i < 500; i++) kept.run("y".repeat(400));
    });
  });

  afterEach(() => db.close());

  test("a file mostly free after a migration shrinks, and keeps every row it still has", () => {
    db.exec("DROP TABLE big");
    const before = db.pageStats();
    expect(compactIfMostlyFree(db, 1024 ** 3)).toBe(true);
    const after = db.pageStats();
    expect(after.free).toBe(0);
    expect(after.pages).toBeLessThan(before.pages / 2);
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM kept").get()!.n).toBe(500);
  });

  test("a file with little free space is left alone", () => {
    db.exec("DELETE FROM kept WHERE id <= 10");
    expect(compactIfMostlyFree(db, 1024 ** 3)).toBe(false);
  });

  test("a file too large to rebuild in the memory that is free is left alone, not risked", () => {
    db.exec("DROP TABLE big");
    expect(compactIfMostlyFree(db, 64 * 1024)).toBe(false);
    expect(db.pageStats().free).toBeGreaterThan(0);
  });
});
