/**
 * What happens to a database that already has data in it.
 *
 * Every other test here starts from an empty file, which is the one case that cannot go wrong. The
 * live install is the opposite: rows written months ago by code that has since been rewritten. A
 * field rename lands on those rows first and is invisible to a fresh-database test.
 *
 * ## What the squash took from this file
 *
 * It used to build a **v13** database by replaying migrations 1..13 — the last version before
 * webhooks — and then run the upgrade. That is gone: a baseline replaced the chain, so
 * migrations 1..13 no longer exist and the path they tested is not one this build offers. Pretending
 * otherwise would need a frozen copy of the old chain in the test tree, which is the squash undone.
 *
 * What remains is the half that is still true and still worth testing: **rows in the old shape, read
 * through the current store.** They are inserted as raw SQL listing only the columns that existed
 * before webhooks, so everything added later takes its default — which is exactly the state a real
 * upgraded row is in. That is what caught the `schedule` → `trigger` rename, and it still would.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { CronSection } from "@nouride/shared";
import { MIGRATIONS } from "@/db/migrations.ts";
import { migrate } from "@/db/index.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";

const DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-upgrade-"));

const CONFIG: CronSection = {
  enabled: true,
  minIntervalMs: 60_000,
  maxJobs: 50,
  runRetentionDays: 14,
  catchupWindowMs: 3_600_000,
  failStreakLimit: 3,
  quietHours: "",
  unattendedApproval: "auto",
  commandTimeoutMs: 600_000,
};

const NOW = Date.parse("2026-08-26T10:00:00Z");

let db: SqliteDb;

/**
 * A job written by the old code.
 *
 * Inserted as raw SQL rather than through the store, because the store is the thing under test — it
 * has been rewritten since these rows were written, and using it to create them would prove only
 * that it agrees with itself.
 *
 * The column list stops where the schema stood before webhooks. Everything added after takes its
 * default, which is what a row that predates those columns actually looks like.
 */
function insertLegacyJob(row: {
  id: string;
  name: string;
  schedule: unknown;
  payload: unknown;
  nextRunAt: number | null;
}): void {
  db.prepare(
    `INSERT INTO cron_jobs (id, agent_id, name, enabled, schedule, payload, delivery,
       created_at, last_run_at, next_run_at, run_count, fail_count,
       target_gateway_id, target_chat_id, session, keep_after_run, created_by,
       fail_streak, disabled_reason)
     VALUES (?, 'nouva', ?, 1, ?, ?, ?, ?, NULL, ?, 4, 1, 'telegram:main', '-100123', 'chat', 0, 'user-7', 0, NULL)`,
  ).run(
    row.id,
    row.name,
    JSON.stringify(row.schedule),
    JSON.stringify(row.payload),
    JSON.stringify({ mode: "announce" }),
    NOW - 86_400_000,
    row.nextRunAt,
  );
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  db = openDatabase(join(DIR, "legacy.db"));
});

afterEach(() => {
  db.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe("upgrading an install that already has jobs", () => {
  beforeEach(async () => {
    await migrate(db);
    insertLegacyJob({
      id: "cron_daily",
      name: "daily report",
      schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Jakarta" },
      payload: { kind: "agentTurn", message: "Summarise yesterday." },
      nextRunAt: NOW + 3_600_000,
    });
    insertLegacyJob({
      id: "cron_interval",
      name: "health check",
      schedule: { kind: "every", everyMs: 900_000 },
      payload: { kind: "systemEvent", text: "still alive" },
      nextRunAt: NOW + 900_000,
    });
    insertLegacyJob({
      id: "cron_once",
      name: "one-shot reminder",
      schedule: { kind: "at", at: NOW + 7_200_000 },
      payload: { kind: "command", argv: ["sh", "-lc", "uptime"], then: "deliver" },
      nextRunAt: NOW + 7_200_000,
    });
  });

  test("the database is at the version a live install is at", () => {
    // Was `13`, and the squash is why it is not: the baseline is the only migration there is, so
    // there is no intermediate version left to start from. See the header.
    expect(db.userVersion()).toBe(MIGRATIONS.at(-1)!.version);
  });

  test("the rows are there, in the shape the old code wrote them", () => {
    const count = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM cron_jobs").get();
    expect(count?.n).toBe(3);

    // The columns added after these rows were written are null or defaulted, not absent — which is
    // what makes them worth reading back through the current store below.
    const row = db
      .prepare<{ webhook_token: string | null }>("SELECT webhook_token FROM cron_jobs WHERE id = ?")
      .get("cron_daily");
    expect(row?.webhook_token).toBeNull();
  });

  test("every legacy job still reads back, with its schedule under the new name", () => {
    // The field was renamed `schedule` → `trigger` while the column stayed `schedule`. If the mapper
    // got that backwards, every existing job would load with an undefined trigger and the scheduler
    // would skip it — silently, because a job that never fires logs nothing.
    const store = new CronStore({ db, config: CONFIG, timezone: "Asia/Jakarta", now: () => NOW });

    const jobs = store.list({ includeDisabled: true });
    expect(jobs).toHaveLength(3);

    const daily = jobs.find((j) => j.id === "cron_daily");
    expect(daily?.trigger).toEqual({ kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Jakarta" });
    expect(daily?.payload).toEqual({ kind: "agentTurn", message: "Summarise yesterday." });
    // Counters and target survive too — a migration that reset run history would look like success.
    expect(daily?.runCount).toBe(4);
    expect(daily?.target).toEqual({ gatewayId: "telegram:main", chatId: "-100123" });
  });

  test("a legacy job has no webhook token and is not reachable by one", () => {
    const store = new CronStore({ db, config: CONFIG, timezone: "Asia/Jakarta", now: () => NOW });

    for (const job of store.list({ includeDisabled: true })) {
      expect(job.webhookToken).toBeUndefined();
    }
    // The partial index has to tolerate three NULLs; a plain UNIQUE would have rejected the second.
    expect(store.byWebhookToken("")).toBeNull();
  });

  test("legacy jobs still come due", () => {
    // The point of the whole exercise. A daemon that migrates cleanly and then never fires anything
    // is the failure that takes a day to notice.
    const store = new CronStore({ db, config: CONFIG, timezone: "Asia/Jakarta", now: () => NOW });

    const due = store.due(NOW + 4_000_000);
    expect(due.map((j) => j.id).sort()).toEqual(["cron_daily", "cron_interval"]);
  });

  test("a schedule still advances on a legacy row", () => {
    const store = new CronStore({ db, config: CONFIG, timezone: "Asia/Jakarta", now: () => NOW });

    const job = store.get("cron_interval")!;
    store.settle(job, { status: "success" });

    expect(store.get("cron_interval")!.nextRunAt).toBe(NOW + 900_000);
  });

  test("a webhook can be created alongside the legacy jobs", () => {
    const store = new CronStore({ db, config: CONFIG, timezone: "Asia/Jakarta", now: () => NOW });

    const hook = store.create({
      agentId: "nouva",
      name: "ci",
      trigger: { kind: "webhook" },
      payload: { kind: "agentTurn", message: "look" },
      target: { gatewayId: "telegram:main", chatId: "-100123" },
      createdBy: "tester",
    });

    expect(store.byWebhookToken(hook.webhookToken!)?.id).toBe(hook.id);
    // And it stays out of the clock's way, next to three jobs that are on it.
    expect(store.due(NOW + 4_000_000).map((j) => j.id)).not.toContain(hook.id);
  });

  test("migrating again is a no-op, as a restart would do", async () => {
    await migrate(db);

    expect(db.userVersion()).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM cron_jobs").get()?.n).toBe(3);
  });
});
