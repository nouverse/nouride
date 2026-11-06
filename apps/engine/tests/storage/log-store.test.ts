/**
 * The log, on disk.
 *
 * The properties here are the ones that make it worth having a table at all rather than only the
 * in-memory ring: it survives the process, it can be searched, it pages backwards, and it is bounded
 * by a retention sweep rather than by hoping. The last one is the important one — a log table that
 * nothing prunes becomes the largest thing in the database, and it does so on the install nobody is
 * looking at.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { LogStore } from "@/commons/logs.store.ts";
import { tempDir } from "../helpers.ts";
import type { LogLevel } from "@nouride/shared";

let db: SqliteDb;
let dataDir: string;
let logs: LogStore;

/** One line, as the logger would hand it over. */
function line(
  over: {
    level?: LogLevel;
    component?: string;
    message?: string;
    at?: number;
    data?: Record<string, unknown>;
  } = {},
) {
  logs.sink({
    timestamp: new Date(over.at ?? Date.now()).toISOString(),
    level: over.level ?? "info",
    component: over.component ?? "pipeline",
    message: over.message ?? "turn complete",
    ...(over.data ? { data: over.data } : {}),
  });
}

beforeEach(async () => {
  dataDir = tempDir("log-store");
  db = await openAndMigrate(join(dataDir, "test.db"));
  logs = new LogStore(db);
});

afterEach(() => {
  db.close();
  removePath(dataDir);
});

describe("what gets written", () => {
  test("info, warn and error are stored; debug is not", () => {
    line({ level: "debug", message: "chunk" });
    line({ level: "info", message: "started" });
    line({ level: "warn", message: "reconnecting" });
    line({ level: "error", message: "boom" });
    logs.flush();

    // `debug` fires per chunk of a stream and is written for somebody watching a terminal. Storing
    // it would make it most of the table.
    expect(logs.query().map((entry) => entry.message)).toEqual(["boom", "reconnecting", "started"]);
  });

  test("nothing is written until the buffer is flushed", () => {
    // A synchronous insert per line would put SQLite on the latency path of everything that logs,
    // including the tool loop and the gateway read path.
    line();
    expect(logs.query()).toHaveLength(0);
    logs.flush();
    expect(logs.query()).toHaveLength(1);
  });

  test("the structured tail survives, and the timestamp becomes a number", () => {
    const at = Date.parse("2026-09-06T10:00:00.000Z");
    line({ at, data: { agent_id: "nouva", tool: "exec", ms: 1200 } });
    logs.flush();

    const [entry] = logs.query();
    expect(entry?.ts).toBe(at);
    expect(entry?.data).toEqual({ agent_id: "nouva", tool: "exec", ms: 1200 });
  });

  test("newest first — the order somebody scrolls a log they are searching", () => {
    line({ at: 1_000, message: "first" });
    line({ at: 2_000, message: "second" });
    logs.flush();
    expect(logs.query().map((e) => e.message)).toEqual(["second", "first"]);
  });
});

describe("finding something in it", () => {
  beforeEach(() => {
    line({ component: "gateway.telegram:bot", message: "connected" });
    line({ component: "pipeline", message: "turn complete", data: { tool: "web_fetch" } });
    line({ component: "pipeline", level: "error", message: "provider refused" });
    logs.flush();
  });

  test("by level, and the level filter means this-and-above", () => {
    expect(logs.query({ minLevel: "error" }).map((e) => e.message)).toEqual(["provider refused"]);
    expect(logs.query({ minLevel: "info" })).toHaveLength(3);
  });

  test("by component, which is the fastest filter there is", () => {
    expect(logs.query({ component: "pipeline" })).toHaveLength(2);
  });

  test("by text, across the message and the fields beside it", () => {
    expect(logs.query({ search: "refused" }).map((e) => e.message)).toEqual(["provider refused"]);
    // The field tail is searched too: `web_fetch` appears nowhere in any message.
    expect(logs.query({ search: "web_fetch" }).map((e) => e.message)).toEqual(["turn complete"]);
  });

  test("a wildcard is a character, not a wildcard", () => {
    line({ message: "disk at 100% again" });
    logs.flush();
    // Unescaped, `%` matches everything — a search that should find one line would hand back the
    // whole table and look like it was not filtering at all.
    expect(logs.query({ search: "%" }).map((e) => e.message)).toEqual(["disk at 100% again"]);
  });

  test("the count is of the filter, not of the page", () => {
    expect(logs.count()).toBe(3);
    expect(logs.count({ minLevel: "error" })).toBe(1);
    expect(logs.query({ limit: 1 })).toHaveLength(1);
  });

  test("components are listed most talkative first, so the filter is a list and not a guess", () => {
    expect(logs.components()[0]).toEqual({ component: "pipeline", entries: 2 });
  });
});

describe("paging backwards", () => {
  test("walks the whole table without repeating or skipping a line", () => {
    for (let i = 0; i < 250; i += 1) line({ at: 1_000 + i, message: `line ${i}` });
    logs.flush();

    const seen: string[] = [];
    let before: number | undefined;
    for (let page = 0; page < 3; page += 1) {
      const rows = logs.query({ limit: 100, ...(before ? { before } : {}) });
      seen.push(...rows.map((row) => row.message));
      before = rows[rows.length - 1]?.id;
    }

    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
  });
});

describe("retention", () => {
  test("drops what is past the window and keeps the rest", () => {
    const now = Date.parse("2026-09-06T10:00:00.000Z");
    const day = 24 * 60 * 60_000;
    line({ at: now - 5 * day, message: "old" });
    line({ at: now - 1 * day, message: "recent" });
    logs.flush();

    expect(logs.sweep(3, now)).toBe(1);
    expect(logs.query().map((e) => e.message)).toEqual(["recent"]);
  });

  test("flushes first, so a pending line cannot land in a range already deleted", () => {
    const now = Date.parse("2026-09-06T10:00:00.000Z");
    line({ at: now - 10 * 24 * 60 * 60_000, message: "old and unflushed" });
    // Never flushed by the caller — the sweep has to do it, or this row appears *after* the delete
    // that was supposed to remove it and lives until the next daily pass.
    expect(logs.sweep(3, now)).toBe(1);
    expect(logs.query()).toHaveLength(0);
  });

  test("zero keeps everything, matching every other retention knob", () => {
    // The opposite reading would make a mistyped zero delete the log on the next sweep, and there is
    // no undo for that.
    line({ at: 1_000 });
    logs.flush();
    expect(logs.sweep(0)).toBe(0);
    expect(logs.query()).toHaveLength(1);
  });

  test("and every window has a row cap: a storm inside one day is cut to the newest, whatever the days say", () => {
    // Time alone bounded the table at the rate the daemon logs — and the fastest day is the one that fills a card.
    const now = Date.parse("2026-09-06T10:00:00.000Z");
    for (let i = 0; i < 5; i += 1) line({ at: now - 60_000 + i, message: `storm ${i}` });
    logs.flush();
    expect(logs.sweep(3, now, 3)).toBe(2);
    expect(logs.query().map((e) => e.message)).toEqual(["storm 4", "storm 3", "storm 2"]);
    expect(logs.sweep(0, now, 2)).toBe(1);
    expect(logs.query()).toHaveLength(2);
  });
});

describe("the span it can answer for", () => {
  test("is null on an empty table rather than a fabricated date", () => {
    expect(logs.span()).toEqual({ oldest: null, newest: null });
  });

  test("is the real window once there is something in it", () => {
    line({ at: 1_000 });
    line({ at: 9_000 });
    logs.flush();
    expect(logs.span()).toEqual({ oldest: 1_000, newest: 9_000 });
  });
});
