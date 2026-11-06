/**
 * The audit log and the log table wake the daemon only when they hold something (E13).
 *
 * Each flushed on a two-second interval — sixty wake-ups a minute between them, on an idle daemon, to find two empty
 * buffers. Now one flush is armed by the first entry into an empty buffer and fires once.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { addLogSink, createLogger, type LogEntry } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { FlushTimer } from "@/commons/flush-timer.ts";
import { LogStore } from "@/commons/logs.store.ts";
import { tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;

beforeEach(async () => {
  dir = tempDir("flush-timers");
  db = await openAndMigrate(join(dir, "test.db"));
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  db.close();
  removePath(dir);
});

const line = (message: string): LogEntry => ({ timestamp: new Date().toISOString(), level: "info", component: "test", message });
const rows = (table: string) => db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

describe.each([
  {
    store: "the audit log",
    table: "audit_log",
    make: () => {
      const audit = new AuditLog(db);
      return { start: () => audit.start(), stop: () => audit.stop(), add: (n: number) => audit.record({ action: `a${n}` }) };
    },
  },
  {
    store: "the log table",
    table: "log_entries",
    make: () => {
      const logs = new LogStore(db);
      return { start: () => logs.start(), stop: () => logs.stop(), add: (n: number) => logs.sink(line(`line ${n}`)) };
    },
  },
])("$store", ({ table, make }) => {
  test("started and idle, has no timer at all", () => {
    const store = make();
    store.start();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(jest.getTimerCount()).toBe(0);
    store.stop();
  });

  test("arms one flush for a burst, writes it once, and is idle again", () => {
    const store = make();
    store.start();
    for (let n = 0; n < 5; n += 1) store.add(n);
    expect(jest.getTimerCount()).toBe(1);
    expect(rows(table)).toBe(0);
    jest.advanceTimersByTime(2_000);
    expect(rows(table)).toBe(5);
    expect(jest.getTimerCount()).toBe(0);
    store.add(5);
    expect(jest.getTimerCount()).toBe(1);
    store.stop();
    expect(jest.getTimerCount()).toBe(0);
    expect(rows(table)).toBe(6);
  });
});

describe("a flush that throws", () => {
  /**
   * Both stores catch their own write today. The timer does not lean on that: out of a timer a throw is an uncaught
   * exception, which the daemon shuts down on — bun fails this test on one.
   */
  test("is said in its owner's log, and the next entry arms another flush", () => {
    const errors: LogEntry[] = [];
    addLogSink((entry) => void (entry.component === "test.buffer" && entry.level === "error" && errors.push(entry)));
    let flushes = 0;
    const flushing = new FlushTimer(
      () => {
        flushes += 1;
        if (flushes === 1) throw new Error("database is locked");
      },
      2_000,
      createLogger("test.buffer"),
    );
    flushing.start();
    flushing.arm();
    jest.advanceTimersByTime(2_000);
    flushing.arm();
    jest.advanceTimersByTime(2_000);
    flushing.stop();
    expect(flushes).toBe(2);
    expect(errors.map((line) => [line.message, line.data?.error])).toEqual([["a buffered flush failed", "Error: database is locked"]]);
  });
});
