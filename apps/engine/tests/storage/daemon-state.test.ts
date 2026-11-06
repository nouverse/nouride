/**
 * `daemon_state` (migration 077, 0.8.18): the table brought to a database of 0.8.17's schema as an upgrade brings it,
 * the store over it, and the read `nouride doctor` makes of the database file, with the daemon running or not.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { databaseVersion, openDatabase, queryDatabaseFile } from "@nouride/runtime";
import { migrate, openAndMigrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { DaemonStateStore, stateInFile } from "@/commons/daemon-state.store.ts";
import { tempDir } from "../helpers.ts";

describe("migration 077 on a database of 0.8.17's schema", () => {
  test("adds the table, empty, keeps every row the database had, and snapshots it first for the way back", async () => {
    const dataDir = tempDir("daemon-state");
    const dbPath = join(dataDir, "nouride.db");
    const old = openDatabase(dbPath);
    await migrate(old, {}, MIGRATIONS.filter((one) => one.version <= 75));
    old.prepare("INSERT INTO sessions (id, agent_id, gateway, chat_id, created_at, updated_at) VALUES ('s1', 'nouva', 'telegram', '555', 1, 1)").run();
    old.close();

    const db = await openAndMigrate(dbPath, MIGRATIONS.filter((one) => one.version <= 77));
    expect(db.userVersion()).toBe(77);
    expect(db.prepare("SELECT * FROM daemon_state").all()).toEqual([]);
    expect(db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "s1" }]);

    // The snapshot `nouride update --rollback` restores: 0.8.17's schema, no table, so 0.8.17 reads its files again. It
    // is named for the first migration the upgrade applied, which is 0.8.18's first.
    const first = String(MIGRATIONS.find((one) => one.version > 75)!.version).padStart(3, "0");
    const snapshots = readdirSync(join(dataDir, "backups", "db")).filter((name) => name.includes(`-before-${first}`));
    expect(snapshots).toHaveLength(1);
    const before = join(dataDir, "backups", "db", snapshots[0]!);
    expect(databaseVersion(before)).toBe(75);
    expect(queryDatabaseFile(before, "SELECT name FROM sqlite_master WHERE name = 'daemon_state'")).toEqual([]);
    db.close();
  });
});

describe("the store", () => {
  test("keeps one row a name, its JSON as written and when, and a write replaces it", async () => {
    const db = openDatabase(":memory:");
    await migrate(db);
    let clock = 1_000;
    const rows = new DaemonStateStore(db, () => clock);
    expect(rows.get("paused-agents")).toBeNull();
    rows.set("paused-agents", '{"paused":["nouva"]}');
    clock = 2_000;
    rows.set("paused-agents", '{"paused":[]}');
    rows.set("agents-seen", '{"nouva":1}');
    expect(rows.get("paused-agents")).toBe('{"paused":[]}');
    expect(db.prepare("SELECT name, value, updated_at FROM daemon_state ORDER BY name").all()).toEqual([
      { name: "agents-seen", value: '{"nouva":1}', updated_at: 2_000 },
      { name: "paused-agents", value: '{"paused":[]}', updated_at: 2_000 },
    ]);
  });
});

describe("a row read off the file, as `nouride doctor` reads it", () => {
  test("is what the daemon wrote, read while it still holds the database open", async () => {
    const dbPath = join(tempDir("daemon-state-doctor"), "nouride.db");
    const db = await openAndMigrate(dbPath);
    new DaemonStateStore(db).set("advisories", '{"version":1,"said":[]}');
    expect(stateInFile(dbPath, "advisories")).toBe('{"version":1,"said":[]}');
    expect(stateInFile(dbPath, "paused-agents")).toBeNull();
    db.close();
  });

  test("is none where there is no database, which it does not make, or one from before the table", async () => {
    const dataDir = tempDir("daemon-state-none");
    expect(stateInFile(join(dataDir, "nouride.db"), "advisories")).toBeNull();
    expect(existsSync(join(dataDir, "nouride.db"))).toBe(false);

    const old = openDatabase(join(dataDir, "nouride.db"));
    await migrate(old, {}, MIGRATIONS.filter((one) => one.version <= 75));
    old.close();
    expect(stateInFile(join(dataDir, "nouride.db"), "advisories")).toBeNull();
  });
});
