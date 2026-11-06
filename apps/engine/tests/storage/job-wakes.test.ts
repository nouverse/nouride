/**
 * A finished job whose wake-up a restart lost is reported at boot (`jobs.woke_at`).
 *
 * The wake-up waits in the pipeline's queue, which is memory. A job that finished a moment before the
 * daemon stopped — its wake-up still behind the turn that started it — was never reported: the agent
 * never heard how it went, and nothing anywhere said so.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { JobWakeStore } from "@/modules/jobs/wakes.store.ts";
import { reportInterruptedJobs } from "@/boot/jobs.ts";
import type { JobRecord, JobStore } from "@/modules/jobs/jobs.store.ts";
import { tempDir } from "../helpers.ts";
import { sleep } from "../wait.ts";

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function insertJob(db: SqliteDb, id: string, status: string, endedAt: number | null, wokeAt?: number): void {
  db.prepare(
    `INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, log_path, started_at, ended_at${wokeAt === undefined ? "" : ", woke_at"})
     VALUES (?, 'nouva', 'telegram:main', '42', 'make', '/tmp', ?, '/tmp/x.log', ?, ?${wokeAt === undefined ? "" : ", ?"})`,
  ).run(...([id, status, (endedAt ?? NOW) - 1000, endedAt, ...(wokeAt === undefined ? [] : [wokeAt])] as never[]));
}

async function migrated(): Promise<SqliteDb> {
  const dir = tempDir("job-wakes");
  cleanup.push(() => removePath(dir));
  const db = await openAndMigrate(join(dir, "t.db"));
  cleanup.push(() => db.close());
  return db;
}

describe("the store", () => {
  test("lists a finished job that never woke its agent, and stops once it has", async () => {
    const db = await migrated();
    const wakes = new JobWakeStore(db);
    insertJob(db, "done", "succeeded", NOW - HOUR);

    expect(wakes.unwoken(NOW - 6 * HOUR, 3)).toEqual(["done"]);
    wakes.markWoken("done", NOW);
    expect(wakes.unwoken(NOW - 6 * HOUR, 3)).toEqual([]);
  });

  test("leaves out what is reported elsewhere, still running, or too old to matter", async () => {
    const db = await migrated();
    const wakes = new JobWakeStore(db);
    insertJob(db, "killed-by-restart", "interrupted", NOW - HOUR); // reportInterrupted says this one
    insertJob(db, "running", "running", null);
    insertJob(db, "yesterday", "failed", NOW - 30 * HOUR);
    insertJob(db, "taken", "failed", NOW - HOUR, NOW - HOUR + 5);
    insertJob(db, "owed", "failed", NOW - 2 * HOUR);

    expect(wakes.unwoken(NOW - 6 * HOUR, 3)).toEqual(["owed"]);
  });

  test("only the first wake-up counts", async () => {
    const db = await migrated();
    const wakes = new JobWakeStore(db);
    insertJob(db, "done", "succeeded", NOW - HOUR);
    wakes.markWoken("done", NOW);
    wakes.markWoken("done", NOW + 5000);
    expect(db.prepare<{ woke_at: number }>("SELECT woke_at FROM jobs WHERE id = 'done'").get()?.woke_at).toBe(NOW);
  });
});

test("boot wakes the agent for those jobs, within the interrupted jobs' bounds", async () => {
  const record = { id: "owed", agentId: "nouva", gatewayId: "telegram:main", chatId: "42", status: "failed" } as JobRecord;
  const asked: { since: number; limit: number }[] = [];
  const woken: { job: JobRecord; tail: string }[] = [];

  reportInterruptedJobs({
    jobs: { reportInterrupted: () => 0, get: () => record, tail: async () => "exit 2" } as unknown as JobStore,
    orphanedJobs: [],
    pipeline: { wakeForJob: (completion) => void woken.push(completion as { job: JobRecord; tail: string }) },
    wakes: {
      unwoken: (since, limit) => {
        asked.push({ since, limit });
        return ["owed"];
      },
    },
    now: NOW,
  });
  await sleep(0);

  expect(asked).toEqual([{ since: NOW - 6 * HOUR, limit: 3 }]);
  expect(woken).toEqual([{ job: record, tail: "exit 2" }]);
});

test("a job the deadline stopped keeps that reason — the row says only `killed`, which reads as somebody's choice", async () => {
  const records: Record<string, JobRecord> = {
    timed: { id: "timed", agentId: "nouva", gatewayId: "telegram:main", chatId: "42", status: "killed" } as JobRecord,
    chosen: { id: "chosen", agentId: "nouva", gatewayId: "telegram:main", chatId: "42", status: "killed" } as JobRecord,
  };
  const woken: { job: JobRecord; stop?: unknown }[] = [];

  reportInterruptedJobs({
    jobs: { reportInterrupted: () => 0, get: (id: string) => records[id], tail: async () => "" } as unknown as JobStore,
    orphanedJobs: [],
    pipeline: { wakeForJob: (completion) => void woken.push(completion) },
    wakes: { unwoken: () => ["timed", "chosen"] },
    audit: { ofActions: () => [{ action: "job_deadline", details: { job: "timed", command: "make", max_ms: 7_200_000 }, timestamp: NOW }] },
    now: NOW,
  });
  await sleep(0);

  expect(Object.fromEntries(woken.map((completion) => [completion.job.id, completion.stop]))).toEqual({
    timed: { by: "deadline", limitMs: 7_200_000 },
    chosen: undefined,
  });
});
