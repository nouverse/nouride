/**
 * The only unauthenticated route on this daemon.
 *
 * So these tests are mostly about what it *refuses* and what it declines to reveal. The one that
 * matters most is the pair of 404s: a scanner must not be able to tell a token that does not exist
 * from one that does and belongs to a switched-off job, because the second answer confirms a guess.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { CronSection } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { CronStore, type JobInput } from "@/modules/cron/cron.store.ts";
import { mountHooks } from "@/modules/web/hooks.ts";
import type { CronScheduler } from "@/modules/cron/scheduler.ts";

const DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-hooks-"));

const CONFIG: CronSection = {
  enabled: true,
  minIntervalMs: 60_000,
  maxJobs: 10,
  runRetentionDays: 14,
  catchupWindowMs: 3_600_000,
  failStreakLimit: 3,
  quietHours: "",
  unattendedApproval: "auto",
  commandTimeoutMs: 600_000,
};

let db: SqliteDb;
let store: CronStore;
let app: Hono;
/** What `runNow` was called with, so a test can assert the body actually reached the scheduler. */
let runs: { id: string; actor: string; trigger?: { body?: string; source?: string } }[];
let outcome: { status: string; result?: string };
let running: boolean;

function input(overrides: Partial<JobInput> = {}): JobInput {
  return {
    agentId: "nouva",
    name: "deploy watcher",
    trigger: { kind: "webhook" },
    payload: { kind: "agentTurn", message: "look at this" },
    target: { gatewayId: "telegram:main", chatId: "12345" },
    createdBy: "tester",
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  db = openDatabase(join(DIR, "t.db"));
  migrate(db);
  store = new CronStore({ db, config: CONFIG, timezone: "UTC" });
  runs = [];
  outcome = { status: "success", result: "delivered" };
  running = false;

  const scheduler = {
    isRunning: () => running,
    runNow: async (id: string, actor: string, trigger?: { body?: string; source?: string }) => {
      runs.push({ id, actor, ...(trigger ? { trigger } : {}) });
      return outcome;
    },
  } as unknown as CronScheduler;

  app = new Hono();
  mountHooks(app, { cron: { store, scheduler } });
});

afterEach(() => {
  db.close();
  rmSync(DIR, { recursive: true, force: true });
});

const post = (path: string, init: RequestInit = {}) =>
  app.request(path, { method: "POST", ...init });

describe("what it refuses", () => {
  test("an unknown token and a disabled job answer identically", async () => {
    // The whole point. If these differed, a scanner that guessed a token would be told so.
    const disabled = store.create(input({ enabled: false }));

    const unknown = await post(`/hooks/${"0".repeat(64)}`);
    const off = await post(`/hooks/${disabled.webhookToken}`);

    expect(unknown.status).toBe(404);
    expect(off.status).toBe(404);
    expect(await unknown.json()).toEqual(await off.json());
    expect(runs).toEqual([]);
  });

  test("a clock-driven job cannot be fired through this route", async () => {
    // It has no token, so there is nothing to address it by — but the guard is explicit rather than
    // relying on that, because a future column default could hand every row an empty string.
    store.create(input({ trigger: { kind: "every", everyMs: 300_000 } }));

    expect((await post("/hooks/")).status).toBe(404);
    expect(runs).toEqual([]);
  });

  test("a body over the cap is refused, and the job is not started", async () => {
    const job = store.create(input());

    const response = await post(`/hooks/${job.webhookToken}`, {
      body: "x".repeat(1024 * 1024 + 1),
      headers: { "content-type": "text/plain" },
    });

    expect(response.status).toBe(413);
    expect(runs).toEqual([]);
  });

  test("a lying content-length does not get past the cap", async () => {
    // The header is written by the caller. Checking only that would be checking nothing.
    const job = store.create(input());

    const response = await post(`/hooks/${job.webhookToken}`, {
      body: "x".repeat(1024 * 1024 + 1),
      headers: { "content-type": "text/plain", "content-length": "10" },
    });

    expect(response.status).toBe(413);
  });
});

describe("what it does", () => {
  test("it answers 202 before the work finishes", async () => {
    // A GitHub delivery times out in ten seconds and an agent turn takes longer. Holding the
    // connection would turn every real job into a failed delivery and a retry storm.
    const job = store.create(input());
    // A run that never finishes: the answer has to come back anyway, and only an unawaited start
    // gives one.
    const hanging = {
      isRunning: () => false,
      runNow: () => new Promise<never>(() => {}),
    } as unknown as CronScheduler;
    const slow = new Hono();
    mountHooks(slow, { cron: { store, scheduler: hanging } });

    const response = await Promise.race([
      slow.request(`/hooks/${job.webhookToken}`, { method: "POST", body: '{"action":"opened"}' }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);

    expect(response?.status).toBe(202);
    expect(await response?.json()).toMatchObject({ job: job.id, accepted: true });
  });

  test("the request body reaches the scheduler", async () => {
    const job = store.create(input());

    await post(`/hooks/${job.webhookToken}`, { body: '{"action":"opened"}' });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: job.id, actor: "webhook" });
    expect(runs[0]!.trigger?.body).toBe('{"action":"opened"}');
  });

  test("an empty body is fine — some hooks are just a ping", async () => {
    const job = store.create(input());

    expect((await post(`/hooks/${job.webhookToken}`)).status).toBe(202);
    expect(runs).toHaveLength(1);
  });

  test("`wait=1` returns the outcome instead", async () => {
    // How a person finds out whether the job they just wrote works, without going to read the run
    // list. Nothing automated should ask for this.
    const job = store.create(input());

    const response = await post(`/hooks/${job.webhookToken}?wait=1`, { body: "{}" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: { status: "success" } });
  });

  test("`wait=1` reports a failed run as a failure", async () => {
    outcome = { status: "error", result: "the agent could not reach the host" };
    const job = store.create(input());

    const response = await post(`/hooks/${job.webhookToken}?wait=1`);

    expect(response.status).toBe(500);
  });

  test("a job already running is refused rather than queued", async () => {
    // The rate limit, such as it is: a public endpoint that starts a provider call per request is a
    // bill waiting to happen, and this makes it impossible to fire one faster than it can finish.
    outcome = { status: "unavailable", result: "that job is already running" };
    const job = store.create(input());

    const response = await post(`/hooks/${job.webhookToken}?wait=1`);

    expect(response.status).toBe(409);
  });

  test("without `wait`, a job already running is refused out loud, not accepted and dropped", async () => {
    // It answered 202 *accepted* here, then `runNow` refused the start with nobody to tell, and no run
    // was recorded — a tracker's event vanished. The sender is told now, and nothing is started.
    running = true;
    const job = store.create(input());

    const response = await post(`/hooks/${job.webhookToken}`, { body: '{"action":"edited"}' });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ job: job.id, accepted: false, reason: "that job is already running" });
    expect(runs).toHaveLength(0);
  });
});

describe("when the scheduler is off", () => {
  test("the route exists and says why it cannot help", async () => {
    const bare = new Hono();
    mountHooks(bare, {});

    const response = await bare.request(`/hooks/${"0".repeat(64)}`, { method: "POST" });

    expect(response.status).toBe(501);
  });
});

/**
 * The brake, which did not exist until a leaked URL was priced.
 *
 * `Scheduler.runNow` refusing a second start while one is running was written here as what stopped
 * this being a way to run up a provider bill, and it is not: it serialises a flood. The two payload
 * kinds that call no model finish in about a millisecond, so they cycle as fast as HTTP allows —
 * one spams the target chat, the other runs a shell line per request.
 */
describe("the rate limit", () => {
  test("the burst is allowed and the next one is refused, with a Retry-After", async () => {
    const job = store.create(input());
    const token = store.get(job.id)!.webhookToken!;

    // 60 a minute is the whole bucket, so the 60th is the last one through.
    for (let i = 0; i < 60; i += 1) {
      const res = await app.request(`/hooks/${token}`, { method: "POST" });
      expect(res.status).toBe(202);
    }

    const refused = await app.request(`/hooks/${token}`, { method: "POST" });
    expect(refused.status).toBe(429);
    // In seconds, because that is what the header means — a client that reads it should wait, not
    // parse milliseconds out of the body.
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(((await refused.json()) as { error: string }).error).toContain("60 a minute");
  });

  test("one webhook's flood does not spend another's allowance", async () => {
    // Why the key is the token and not the address: both of these calls arrive from the same place.
    const busy = store.get(store.create(input({ name: "busy" })).id)!.webhookToken!;
    const quiet = store.get(store.create(input({ name: "quiet" })).id)!.webhookToken!;

    for (let i = 0; i < 61; i += 1) await app.request(`/hooks/${busy}`, { method: "POST" });
    expect((await app.request(`/hooks/${busy}`, { method: "POST" })).status).toBe(429);

    expect((await app.request(`/hooks/${quiet}`, { method: "POST" })).status).toBe(202);
  });

  test("an unknown token is still a 404, never a 429", async () => {
    /**
     * The limit is applied after the token is matched, deliberately. Counting unknown tokens would
     * let a scanner consume the allowance of whichever real token it eventually guesses, and a 429
     * where a 404 belongs tells it that something about the request was interesting.
     */
    for (let i = 0; i < 80; i += 1) {
      const res = await app.request("/hooks/0000000000000000000000000000000000000000000000000000000000000000", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    }
  });
});
