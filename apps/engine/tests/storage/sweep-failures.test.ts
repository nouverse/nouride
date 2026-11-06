/**
 * Housekeeping that fails, failing on its own (`boot/maintenance.ts`).
 *
 * Every one of these timers reaches a store or the disk, and a throw out of a timer is an uncaught exception, which the
 * daemon shuts down on (`boot/shutdown.ts`): a table locked at the wrong moment in the nightly sweep ended every
 * conversation to report it. Bun fails the running test on an uncaught exception or an unhandled rejection, so a test
 * here that lets one out fails whatever it asserts — and each also asserts the next round still comes.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { rmSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { addLogSink, type GlobalConfig, type LogEntry } from "@nouride/shared";
import { startDatabaseBackups, startDiskAlerts, startRetentionSweep } from "@/boot/maintenance.ts";
import type { Notifier } from "@/commons/notify.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { tempDir } from "../helpers.ts";

const DAY = 24 * 60 * 60_000;

const errors: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "daemon" && entry.level === "error" && errors.push(entry)));

let dir: string;
let db: SqliteDb;

beforeEach(() => {
  dir = tempDir("sweep-failures");
  db = openDatabase(`${dir}/nouride.db`);
  errors.length = 0;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function config(): GlobalConfig {
  const base = structuredClone(DEFAULT_CONFIG) as GlobalConfig;
  return { ...base, daemon: { ...base.daemon, dataDir: dir, workspaceDir: dir } };
}

describe("the retention sweep", () => {
  /** Every store a spy that counts; `sessions` throws from the second day on — the boot sweep is not the one failing. */
  function stores(failing: { from: number }) {
    const swept: Record<string, number> = {};
    const count = (name: string) => ({
      sweep: () => {
        swept[name] = (swept[name] ?? 0) + 1;
        if (name === "sessions" && swept[name]! >= failing.from) throw new Error("database is locked");
        return 0;
      },
    });
    const deps = {
      config: config(),
      attachments: { sweep: () => ({ removed: 0, freedBytes: 0 }) },
      usage: count("usage"),
      sessions: count("sessions"),
      turns: count("turns"),
      chatEvents: count("chatEvents"),
      roomMessages: count("roomMessages"),
      attachmentIndex: count("attachmentIndex"),
      jobs: { sweepLogs: () => 0 },
      spill: count("spill"),
      uploads: { sweep: () => 0 },
      audit: count("audit"),
      approvals: count("approvals"),
      logs: count("logs"),
      cron: { sweepRuns: () => ((swept.cron = (swept.cron ?? 0) + 1), 0) },
      drafts: count("drafts"),
    } as never as Parameters<typeof startRetentionSweep>[0];
    return { deps, swept };
  }

  test("a store whose sweep throws is logged by name, the stores after it are swept, and the next day comes", () => {
    const { deps, swept } = stores({ from: 2 });
    const timer = startRetentionSweep(deps);
    try {
      jest.advanceTimersByTime(DAY);
      jest.advanceTimersByTime(DAY);
    } finally {
      clearInterval(timer);
    }
    // Boot, then two days: sessions threw on both days, and everything after it was swept all three times.
    expect(swept.sessions).toBe(3);
    for (const after of ["turns", "audit", "logs", "approvals", "drafts", "cron"]) expect({ after, times: swept[after] }).toEqual({ after, times: 3 });
    expect(errors.map((line) => [line.message, line.data?.store, line.data?.error])).toEqual([
      ["a retention sweep failed, but the other stores are swept anyway", "sessions", "Error: database is locked"],
      ["a retention sweep failed, but the other stores are swept anyway", "sessions", "Error: database is locked"],
    ]);
  });
});

describe("a scheduled snapshot", () => {
  test("that throws is logged as that snapshot's, and the next day's is looked at all the same", () => {
    let asked = 0;
    // What the database snapshot asks first; a store that cannot answer throws from inside the hourly check.
    const writes = () => {
      asked += 1;
      throw new Error("Cannot use a closed database");
    };
    const timer = startDatabaseBackups(config(), db, Date.now, writes);
    try {
      jest.advanceTimersByTime(DAY);
    } finally {
      clearInterval(timer);
    }
    // At boot, and once a day after: a failed look waits for the next day rather than retrying every hour.
    expect(asked).toBe(2);
    expect(errors.map((line) => [line.message, line.data?.snapshot])).toEqual([
      ["a scheduled snapshot could not be taken", "database"],
      ["a scheduled snapshot could not be taken", "database"],
    ]);
  });
});

describe("the disk alert", () => {
  test("whose alert fails is logged, and the next heartbeat looks again", () => {
    let alerts = 0;
    const notifier = {
      alert: () => {
        alerts += 1;
        throw new Error("the alert chat's gateway is gone");
      },
    } as unknown as Notifier;
    const cfg = config();
    // Short of space whatever the disk holds, so every heartbeat alerts.
    const timer = startDiskAlerts(cfg, notifier, { warnBelowMb: Number.MAX_SAFE_INTEGER, everyMs: 1_000 });
    try {
      jest.advanceTimersByTime(2_000);
    } finally {
      clearInterval(timer);
    }
    expect(alerts).toBe(2);
    expect(errors.map((line) => line.message)).toEqual(["could not check the free disk space", "could not check the free disk space"]);
  });
});
