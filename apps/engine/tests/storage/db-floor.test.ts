/**
 * A database from before the floor — schema below 69, the one 0.8.0 left — is refused with the way across, "install
 * 0.8.0 first", before anything is applied or snapshotted. One 0.8.0 left is taken as it is, and the baseline alone
 * makes a new one holding the fingerprint 0.8.0 gave the same schema.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, openDatabase, removePath } from "@nouride/runtime";
import { adoptSchema, migrate, openAndMigrate, SchemaDriftError } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { tempDir } from "../helpers.ts";

/**
 * What 0.8.0 stamped on every database it ran on: the fingerprint of its chain, `068_baseline.sql` (0.7.28's,
 * 1737727765) then `069_missions_automations.sql` — the same on a new database and on one it brought from 68.
 */
const FINGERPRINT_0_8_0 = -804988230;

let dir: string;
let path: string;

beforeEach(() => {
  dir = tempDir("db-floor");
  ensureDir(join(dir, "data"));
  path = join(dir, "data", "nouride.db");
});

afterEach(() => {
  removePath(dir);
});

/** A database an older build left at `version`: a table with a row, its version, a fingerprint. */
function olderDatabase(version: number, fingerprint = 12345): void {
  const db = openDatabase(path);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('ses_1')");
  db.setUserVersion(version);
  db.setApplicationId(fingerprint);
  db.close();
}

/** A database as 0.8.0 left it: its schema, its fingerprint, a row. */
function databaseOf080(): void {
  const db = openDatabase(path);
  db.exec(MIGRATIONS[0]!.sql);
  db.setUserVersion(69);
  db.setApplicationId(FINGERPRINT_0_8_0);
  db.exec(`INSERT INTO sessions (id, agent_id, chat_id, gateway, created_at, updated_at) VALUES ('ses_nouva:telegram:main:1', 'nouva', '1', 'telegram:main', 1, 2)`);
  db.close();
}

const header = () => {
  const db = openDatabase(path);
  try {
    return { version: db.userVersion(), id: db.applicationId() };
  } finally {
    db.close();
  }
};

test("a database the last 0.7.x left at 68 is refused at start, naming the floor and its image — and nothing is applied or snapshotted", async () => {
  // As 0.7.28 and 0.7.29 left one: its schema's version, and the fingerprint 0.7.28's chain stamped.
  olderDatabase(68, 1737727765);
  const before = header();

  const refused = await openAndMigrate(path).then(
    () => null,
    (err: unknown) => err,
  );

  expect(refused).toBeInstanceOf(SchemaDriftError);
  const message = (refused as Error).message;
  expect(message).toStartWith("refusing to start: this database is at schema 68, from before 0.8.0, and this version upgrades only from 0.8.0. Install 0.8.0 first.");
  expect(message).toContain("install 0.8.0 and start it once (it migrates the database, after a snapshot), then this version again");
  expect(message).toContain("run ghcr.io/nouverse/nouride:0.8.0 once on the same volume");
  expect(header()).toEqual(before);
  expect(existsSync(join(dir, "data", "backups"))).toBe(false);
});

test("a 0.5 database too, and neither the override nor adopt gets past it", async () => {
  olderDatabase(32);
  process.env.NOURIDE_ALLOW_SCHEMA_DRIFT = "1";
  try {
    const db = openDatabase(path);
    try {
      await expect(migrate(db)).rejects.toThrow(/schema 32, from before 0\.8\.0, .* Install 0\.8\.0 first/);
      expect(() => adoptSchema(db)).toThrow(/schema 32, from before 0\.8\.0/);
      expect(db.userVersion()).toBe(32);
    } finally {
      db.close();
    }
  } finally {
    delete process.env.NOURIDE_ALLOW_SCHEMA_DRIFT;
  }
});

test("a database 0.8.0 left is taken as it is: its fingerprint matches, nothing is applied or snapshotted, its rows kept", async () => {
  databaseOf080();
  // Against the baseline alone: what comes after it (`070_mission_branch.sql`, 0.8.7) is applied as any migration is.
  const db = await openAndMigrate(path, MIGRATIONS.slice(0, 1));
  try {
    expect({ version: db.userVersion(), id: db.applicationId() }).toEqual({ version: 69, id: FINGERPRINT_0_8_0 });
    expect(db.prepare<{ id: string }>("SELECT id FROM sessions").all()).toEqual([{ id: "ses_nouva:telegram:main:1" }]);
  } finally {
    db.close();
  }
  expect(existsSync(join(dir, "data", "backups"))).toBe(false);
});

test("the baseline alone makes a new database with the fingerprint 0.8.0 gave the same schema", async () => {
  const db = await openAndMigrate(path, MIGRATIONS.slice(0, 1));
  try {
    expect(db.userVersion()).toBe(69);
    expect(db.applicationId()).toBe(FINGERPRINT_0_8_0);
  } finally {
    db.close();
  }
});
