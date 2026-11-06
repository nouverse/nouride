/**
 * `db/keys.ts` against the schema that ships — every migration applied.
 *
 * The registry exists because hand-kept lists of key columns only ever shrank: a dropped table made the gateway
 * rename throw, so it was noticed, and every table added after the rename was written was missed in silence — the room
 * log, the event stream, the inbox, the turn journal, all of memory. So this walks the real schema in both directions:
 * a column whose name says it holds a key fails until it is classified, an entry naming a column that is gone fails,
 * and the rename is run over a row in every table to prove the registry is what it rewrites.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { IN_FLIGHT, KEY_COLUMNS, ON_CONVERSATION_DELETE, type KeyColumn } from "@/db/keys.ts";
import { applyRename, planRename } from "@/modules/gateways/rename.ts";
import { tempDir } from "../helpers.ts";

/**
 * What a key's column is called, here. A heuristic, and the reason the registry is checked both ways: a column named
 * like this that nobody classified is the next one an operation would miss.
 */
const KEY_SHAPED = /(?:^|_)(?:gateway|session|chat|agent|person|sender|subject|readers)(?:_id)?$|^agents$|^(?:delivery|envelope|entry|data)$/;

/** Names that read like a key and hold none — and why. */
const NOT_KEYS: Record<string, string> = {
  "cron_jobs.session": "which history a job runs against — `fresh`, `isolated` or `chat` — a mode, not a conversation's id",
};

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

let dir: string;
let db: SqliteDb;
/** Every ordinary table, with its columns — not SQLite's own, nor a virtual table and the shadow tables behind it. */
let tables: Map<string, Column[]>;

beforeAll(async () => {
  dir = tempDir("key-columns");
  db = await openAndMigrate(join(dir, "test.db"));
  const all = db.prepare<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const virtual = all.filter((table) => /^CREATE VIRTUAL TABLE/i.test(table.sql)).map((table) => table.name);
  tables = new Map(
    all
      .filter((table) => !virtual.some((name) => table.name === name || table.name.startsWith(`${name}_`)))
      .map((table) => [table.name, db.prepare<Column>("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?)").all(table.name)]),
  );
});

afterAll(() => {
  db.close();
  removePath(dir);
});

const keyOf = (table: string, column: string) => `${table}.${column}`;
const registered = (table: string, column: string): KeyColumn | undefined =>
  KEY_COLUMNS.find((key) => key.table === table && key.column === column);

describe("the registry and the schema", () => {
  test("every entry names a column that exists, once", () => {
    const missing = KEY_COLUMNS.filter((key) => !tables.get(key.table)?.some((column) => column.name === key.column)).map((key) => keyOf(key.table, key.column));
    expect(missing).toEqual([]);
    const names = KEY_COLUMNS.map((key) => keyOf(key.table, key.column));
    expect(names.length).toBe(new Set(names).size);
  });

  test("every column named like a key is classified — a new one fails here until it is", () => {
    const unclassified: string[] = [];
    for (const [table, columns] of tables) {
      for (const column of columns) {
        if (!KEY_SHAPED.test(column.name)) continue;
        if (registered(table, column.name) || NOT_KEYS[keyOf(table, column.name)]) continue;
        unclassified.push(keyOf(table, column.name));
      }
    }
    expect(unclassified).toEqual([]);
  });

  test("a document says where in it the key is, and nothing else does", () => {
    for (const key of KEY_COLUMNS) {
      expect({ key: keyOf(key.table, key.column), paths: key.kind === "json" ? Object.keys(key.paths ?? {}).length > 0 : key.paths === undefined }).toEqual({
        key: keyOf(key.table, key.column),
        paths: true,
      });
    }
  });

  test("work in flight is told apart by a condition the schema can run", () => {
    for (const [table, condition] of Object.entries(IN_FLIGHT)) {
      expect(tables.has(table)).toBe(true);
      expect(() => db.prepare(`SELECT COUNT(*) AS n FROM ${table}${condition ? ` WHERE ${condition}` : ""}`).get()).not.toThrow();
    }
  });

  test("every table that names a conversation says what deleting one does to it, and no other table does", () => {
    const conversational = [...tables.keys()].filter((table) => {
      const keys = KEY_COLUMNS.filter((key) => key.table === table);
      return keys.some((key) => key.kind === "session") || (keys.some((key) => key.kind === "gateway") && keys.some((key) => key.kind === "chatId"));
    });
    expect(Object.keys(ON_CONVERSATION_DELETE).sort()).toEqual(conversational.sort());
  });
});

const FROM = "telegram:bot";
const TO = "telegram:nouva";
/** Another gateway — for what is in flight, which the rename refuses rather than rewrites. */
const OTHER = "telegram:other";

/** A value in the shape a key of this kind takes, naming `gateway`. */
function keyValue(kind: "gateway" | "session" | "gatewayPrefixed", gateway: string): string {
  if (kind === "gateway") return gateway;
  if (kind === "session") return `ses_nouva:${gateway}:111`;
  return `${gateway}:111:m1`;
}

/** A JSON document with each path set — `$.head.gatewayId` as `{"head":{"gatewayId":…}}`. */
function document(paths: Readonly<Record<string, "gateway" | "session">>, gateway: string): string {
  const out: Record<string, unknown> = {};
  for (const [path, kind] of Object.entries(paths)) {
    const steps = path.replace(/^\$\./, "").split(".");
    let at = out;
    for (const step of steps.slice(0, -1)) at = (at[step] ??= {}) as Record<string, unknown>;
    at[steps.at(-1)!] = keyValue(kind, gateway);
  }
  return JSON.stringify(out);
}

/**
 * One row in `table`, every column filled: each registered key naming `gateway` in its shape, a record naming it too,
 * everything else a placeholder of its type. Work in flight — every row of the journal — names another gateway, and
 * the inbox's row is a settled one: in flight, the rename refuses rather than rewrite them (tested in
 * `gateway-rename.test.ts`).
 */
function seed(table: string, columns: Column[], gateway: string): void {
  const inFlightAlways = IN_FLIGHT[table] === null;
  const values = columns.map((column) => {
    const key = registered(table, column.name);
    const named = inFlightAlways ? OTHER : gateway;
    if (key?.kind === "json") return document(key.paths ?? {}, named);
    if (key?.kind === "gateway" || key?.kind === "session" || key?.kind === "gatewayPrefixed") return keyValue(key.kind, named);
    if (key?.kind === "text") return JSON.stringify({ gateway_id: named });
    if (table === "inbox" && column.name === "status") return "done";
    if (/INT/i.test(column.type)) return 1;
    if (/REAL/i.test(column.type)) return 1.5;
    return `${column.name}-value`;
  });
  db.prepare(`INSERT INTO ${table} (${columns.map((column) => `"${column.name}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
}

describe("the rename reaches every column the registry says names a gateway", () => {
  test("after it, only records still name the old id — and every key it rewrote names the new one", () => {
    db.exec("PRAGMA foreign_keys = OFF");
    for (const [table, columns] of tables) seed(table, columns, FROM);

    const plan = planRename({ db, config: "", from: FROM, to: TO, existing: [] });
    applyRename(db, plan);

    const stillOld: string[] = [];
    for (const [table, columns] of tables) {
      for (const column of columns) {
        const n = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE CAST("${column.name}" AS TEXT) LIKE ?`).get(`%${FROM}%`)!.n;
        if (n > 0) stillOld.push(keyOf(table, column.name));
      }
    }
    // The records that were seeded naming it — a gateway as it was, a log line — and nothing else.
    const records = KEY_COLUMNS.filter((key) => key.record && ["gateway", "session", "gatewayPrefixed", "json", "text"].includes(key.kind));
    expect(records.length).toBeGreaterThan(0);
    expect(stillOld.sort()).toEqual(records.map((key) => keyOf(key.table, key.column)).sort());

    const rewritten = KEY_COLUMNS.filter((key) => !key.record && ["gateway", "session", "gatewayPrefixed", "json"].includes(key.kind) && IN_FLIGHT[key.table] !== null);
    const notNew = rewritten
      .filter((key) => db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${key.table} WHERE "${key.column}" LIKE ?`).get(`%${TO}%`)!.n === 0)
      .map((key) => keyOf(key.table, key.column));
    expect(notNew).toEqual([]);
  });
});
