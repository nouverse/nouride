/**
 * *Always for this job* (0.8.0): what a run's guards held with nobody there to ask is kept on the run; a person allows
 * it for the job — from its page, or by answering a mission's question — and its runs send there without asking again.
 * Only that destination, only that job; taken back, it is asked again.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { migrate } from "@/db/index.ts";
import { CronStore, type JobInput } from "@/modules/cron/cron.store.ts";
import { CronScheduler, type CronExecutors } from "@/modules/cron/scheduler.ts";
import { registerCronRoutes } from "@/modules/web/control/routes/cron.ts";

let dir: string;
let db: SqliteDb;
let store: CronStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "job-allowances-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  store = new CronStore({ db, config: DEFAULT_CONFIG.cron, timezone: "UTC" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = (over: Partial<JobInput> = {}): JobInput => ({
  agentId: "nouva",
  name: "mail digest",
  trigger: { kind: "every", everyMs: 3_600_000 },
  payload: { kind: "agentTurn", message: "Sum up the mail for the team." },
  target: { gatewayId: "telegram:nouva", chatId: "-100team" },
  delivery: { mode: "none" },
  createdBy: "t",
  ...over,
});

const HELD = { keys: ["chat:telegram:nouva:555"], label: "sends a message to the telegram one-to-one with Mira", reason: "this run of a scheduled job sends to its own chat" };

describe("on the job and its runs", () => {
  test("what a run's guards held is on the run, however it ended", async () => {
    const job = store.create(input());
    const executors = { runTurn: async () => ({ text: "Done, but I could not tell Mira.", held: [HELD] }), dispatchTurn: () => true, deliver: async () => ({ ok: true }), commandSandbox: () => ({ cwd: dir, env: {} }) } as unknown as CronExecutors;
    const scheduler = new CronScheduler({ store, config: DEFAULT_CONFIG.cron, maxSleepMs: 5, executors });
    expect((await scheduler.runNow(job.id, "tester")).status).toBe("success");
    expect(store.runs(job.id)[0]?.held).toEqual([HELD]);
    expect(store.recentRuns()[0]?.held).toEqual([HELD]);
  });

  test("allowed once per destination, by whom and when; taken back by any key it holds", () => {
    const job = store.create(input());
    store.allow(job.id, { keys: HELD.keys, label: HELD.label }, "gading");
    store.allow(job.id, { keys: HELD.keys, label: HELD.label }, "gading");
    expect(store.get(job.id)?.allowed).toEqual([{ keys: HELD.keys, label: HELD.label, by: "gading", at: expect.any(Number) }]);
    // Nothing named, nothing allowed: an allowance must say where.
    store.allow(job.id, { keys: [], label: "anything" }, "gading");
    expect(store.get(job.id)?.allowed).toHaveLength(1);
    store.disallow(job.id, "chat:telegram:nouva:555", "gading");
    expect(store.get(job.id)?.allowed).toBeUndefined();
  });
});

describe("POST /cron/:id/allowed", () => {
  function control(role: "admin" | "operator" | "viewer") {
    const app = new Hono<{ Variables: { principal: unknown } }>();
    app.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: role, role, user: { id: `usr_${role}`, username: role } });
      await next();
    });
    registerCronRoutes(app as never, { ctx: { config: { people: [] } }, cron: { store, scheduler: {}, timezone: "UTC" } } as never);
    return (id: string, body: unknown) => app.request(`/cron/${id}/allowed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  test("an operator allows a scheduled job's held action, and takes it back; a viewer may not", async () => {
    // Each on a job of their own: another person's is not there for them at all (`whose.ts`).
    const viewers = store.create(input({ owner: "web:usr_viewer" }));
    expect((await control("viewer")(viewers.id, { add: { keys: HELD.keys, label: HELD.label } })).status).toBe(403);
    const job = store.create(input({ owner: "web:usr_operator" }));
    expect((await control("viewer")(job.id, { add: { keys: HELD.keys, label: HELD.label } })).status).toBe(404);
    const added = await control("operator")(job.id, { add: { keys: HELD.keys, label: HELD.label } });
    expect(added.status).toBe(200);
    expect(store.get(job.id)?.allowed?.map((one) => one.by)).toEqual(["operator"]);
    expect((await control("operator")(job.id, { remove: HELD.keys[0] })).status).toBe(200);
    expect(store.get(job.id)?.allowed).toBeUndefined();
    expect((await control("operator")(job.id, { add: { keys: [], label: "x" } })).status).toBe(400);
  });

  test("a webhook's is an admin's, as making one is", async () => {
    const hook = store.create(input({ trigger: { kind: "webhook" }, owner: "web:usr_operator" }));
    expect((await control("operator")(hook.id, { add: { keys: HELD.keys, label: HELD.label } })).status).toBe(403);
    expect((await control("admin")(hook.id, { add: { keys: HELD.keys, label: HELD.label } })).status).toBe(200);
  });
});
