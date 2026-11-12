/**
 * Each person's automations and missions their own, at every door (`web/control/whose.ts`): over the real job store,
 * the real missions and the real routes, an operator asking for another person's automation or mission, by its id or
 * in a list, is answered as for one that is not there, and changes nothing. Their own opens and changes. One that
 * only reports to a chat of theirs is read and not changed. An admin reads everyone's, set apart by person.
 *
 * And the contract that keeps it: every route that names or lists an automation, a webhook or a mission asks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { CronSection } from "@nouride/shared";
import type { AutomationSummary, JobSummary, MissionView, WaitingStep, WebhookSummary } from "@nouride/wire";
import { migrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore, type JobInput } from "@/modules/cron/cron.store.ts";
import { proposalFor } from "@/modules/cron/proposals.ts";
import { registerAutomationRoutes } from "@/modules/web/control/routes/automations.ts";
import { registerCronRoutes } from "@/modules/web/control/routes/cron.ts";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { registerWebhookRoutes } from "@/modules/web/control/routes/webhooks.ts";
import { missionsHarness } from "../missions/harness.ts";

const LOCAL = "web:dashboard";
const PEOPLE = [
  { key: "gading", name: "Gading", ids: ["web:u1", "telegram:814"] },
  { key: "rina", name: "Rina", ids: ["web:u2", "telegram:555"] },
  // In People by name only: no account and no chat app, so nothing can be kept as theirs.
  { key: "tamu", name: "Tamu", ids: [] },
];
const ACCOUNTS = {
  gading: { kind: "user", actor: "gading", role: "admin", user: { id: "u1", username: "gading", displayName: "Gading", role: "admin" } },
  rina: { kind: "user", actor: "rina", role: "operator", user: { id: "u2", username: "rina", displayName: "Rina", role: "operator" } },
  tamu: { kind: "user", actor: "tamu", role: "viewer", user: { id: "u3", username: "tamu", displayName: "", role: "viewer" } },
  cli: { kind: "token", actor: "cli", role: "admin" },
} as const;

/** The private chats, by who opened each: the admin's on Telegram, Rina's on Telegram and on the dashboard. */
const HIS_CHAT = { gatewayId: "telegram:nouva", chatId: "814" };
const HER_CHAT = { gatewayId: "telegram:nouva", chatId: "555" };
const HER_WEB = { gatewayId: LOCAL, chatId: "web-r" };
const OPENERS: Record<string, string> = { "telegram:nouva|814": "telegram:814", "telegram:nouva|555": "telegram:555", "web:dashboard|web-r": "web:u2" };

const CONFIG: CronSection = {
  enabled: true,
  minIntervalMs: 1000,
  maxJobs: 20,
  runRetentionDays: 14,
  catchupWindowMs: 60_000,
  failStreakLimit: 3,
  quietHours: "",
  unattendedApproval: "auto",
  commandTimeoutMs: 5000,
};

let dir: string;
let db: SqliteDb;
let as: keyof typeof ACCOUNTS = "rina";
const cleanup: (() => void)[] = [];

beforeEach(() => {
  as = "rina";
});
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

const job = (over: Partial<JobInput> = {}): JobInput => ({
  agentId: "nova",
  name: "a job",
  trigger: { kind: "every", everyMs: 60_000 },
  payload: { kind: "systemEvent", text: "ping" },
  target: HIS_CHAT,
  createdBy: "gading",
  ...over,
});

async function house() {
  dir = mkdtempSync(join(tmpdir(), "nouride-tmp-thing-doors-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  cleanup.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new CronStore({ db, config: CONFIG, timezone: "UTC", now: () => Date.parse("2026-11-13T00:00:00Z") });
  const ran: string[] = [];
  const answered: { run: string; go: boolean; by: string }[] = [];
  /** A run that waits for a person, for each job named: the store has none without a scheduler at work. */
  const waiting: { runId: string; jobId: string }[] = [];

  const jobs = {
    hers: store.create(job({ name: "hers", owner: "web:u2", target: HER_WEB, createdBy: "rina" })),
    his: store.create(job({ name: "his", owner: "web:u1" })),
    // The admin's, and it tells Rina's chat every morning.
    toHer: store.create(job({ name: "to her", owner: "web:u1", target: HER_CHAT })),
    // From the command line: nobody's. It reports to the admin's chat.
    nobodys: store.create(job({ name: "nobody's", createdBy: "cli" })),
    // An agent proposed it in Rina's chat on the dashboard: off, and nobody's until someone says yes.
    proposal: store.create(job({ name: "proposed", createdBy: "agent:nova", target: HER_WEB, proposal: proposalFor("nova", { ...HER_WEB, senderId: "u2" }, 1) })),
    // The admin's webhook, which reports to Rina's chat.
    hook: store.create(job({ name: "hook", owner: "web:u1", target: HER_CHAT, trigger: { kind: "webhook" } })),
  };

  const h = await missionsHarness({ settings: { perAgent: 4, maxRunning: 8 } });
  const start = (goal: string, over: Record<string, unknown>) => h.start(goal, over);
  const missions = {
    hers: await start("hers", { startedBy: "u2", gatewayId: LOCAL, chatId: "missions" }),
    his: await start("his", { startedBy: "814", gatewayId: HIS_CHAT.gatewayId, chatId: HIS_CHAT.chatId }),
    // The admin started it from the dashboard to report to Rina's chat.
    toHer: await start("to her", { startedBy: "u1", owner: "web:u1", gatewayId: HER_CHAT.gatewayId, chatId: HER_CHAT.chatId }),
    // An agent proposed it on its own in Rina's chat: nobody's, waiting for a yes.
    proposed: await start("proposed", { startedBy: "nouride:system", byAgent: "nova", proposed: true, gatewayId: HER_CHAT.gatewayId, chatId: HER_CHAT.chatId }),
  };

  const deps = {
    ctx: { config: { ...structuredClone(DEFAULT_CONFIG), people: PEOPLE } },
    cron: {
      timezone: "UTC",
      // What a webhook's test is sent through: never reached here, a route that has none answers that it has none.
      tests: {},
      store: new Proxy(store, {
        get: (real, name) =>
          name === "waitingRuns"
            ? () => waiting.map((one) => ({ run: { id: one.runId, jobId: one.jobId }, state: { wait: { kind: "approval", ask: "Go on?", since: 1 } } }))
            : Reflect.get(real, name, real),
      }),
      scheduler: {
        runNow: async (id: string) => (ran.push(id), { status: "success" }),
        answerRun: (run: string, go: boolean, by: string) => (answered.push({ run, go, by }), { settled: "ok" }),
      },
    },
    missions: h.missions,
    notes: h.notes,
    approvals: { pending: () => [] },
    audit: { record: () => {} },
    registry: { get: () => ({ config: { id: "nova" } }) },
    sessions: { openerOfChat: (gatewayId: string, chatId: string) => OPENERS[`${gatewayId}|${chatId}`] },
    rooms: { get: () => null },
    roomMessages: { isRoom: () => false, spokeIn: () => new Set<string>() },
    pipeline: { chatTypeOf: () => "dm" },
  };
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", ACCOUNTS[as]);
    await next();
  });
  for (const register of [registerAutomationRoutes, registerCronRoutes, registerWebhookRoutes, registerMissionRoutes]) register(app as never, deps as never);
  const ask = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const names = async (path: string, key: string) => ((await ask("GET", path)).body[key] as { name?: string; goal?: string }[]).map((one) => one.name ?? one.goal).sort();
  return { ask, names, store, jobs, missions, h, ran, answered, waiting };
}

describe("an operator's lists", () => {
  test("automations: her own, the one that tells her chat, and what was proposed there; none of another person's", async () => {
    const h = await house();
    expect(await h.names("/automations", "automations")).toEqual(["hers", "hook", "proposed", "to her"]);
    expect(await h.names("/cron?all=1", "jobs")).toEqual(["hers", "proposed", "to her"]);
    // Asking for everyone's, or another person's, is an admin's: she is answered with her own.
    expect(await h.names("/automations?whose=everyone", "automations")).toEqual(["hers", "hook", "proposed", "to her"]);
    expect(await h.names("/automations?whose=person:gading", "automations")).toEqual(["hers", "hook", "proposed", "to her"]);
  });

  test("each says whose it is, as a person, and whether she may change it; never the id it is kept under", async () => {
    const h = await house();
    const listed = (await h.ask("GET", "/automations")).body.automations as (AutomationSummary & { owner?: string })[];
    const said = Object.fromEntries(listed.map((one) => [one.name, [one.person?.name ?? "-", one.changeable]]));
    expect(said).toEqual({ hers: ["Rina", true], "to her": ["Gading", false], proposed: ["-", true], hook: ["Gading", false] });
    expect(listed.some((one) => "owner" in one)).toBe(false);
    // The schedule's own routes answer the same row: the list, one job, and what a change answers.
    const jobs = (await h.ask("GET", "/cron?all=1")).body.jobs as (JobSummary & { owner?: string })[];
    expect(Object.fromEntries(jobs.map((one) => [one.name, [one.person?.name ?? "-", one.changeable]]))).toEqual({ hers: ["Rina", true], "to her": ["Gading", false], proposed: ["-", true] });
    expect(jobs.some((one) => "owner" in one)).toBe(false);
    expect("owner" in ((await h.ask("GET", `/cron/${h.jobs.hers.id}`)).body.job as object)).toBe(false);
    expect("owner" in ((await h.ask("POST", `/cron/${h.jobs.hers.id}/disable`)).body.job as object)).toBe(false);
  });

  test("a webhook she only reads comes without its address: the way to call it is its owner's", async () => {
    const h = await house();
    const hook = ((await h.ask("GET", "/automations")).body.automations as AutomationSummary[]).find((one) => one.name === "hook")!;
    expect(hook.hook).toBeUndefined();
    expect(JSON.stringify(hook)).not.toContain(h.jobs.hook.webhookToken!);
    expect((await h.ask("GET", "/webhooks")).body.webhooks).toEqual([]);
    as = "gading";
    const his = ((await h.ask("GET", "/webhooks")).body.webhooks as WebhookSummary[])[0]!;
    expect(his.webhookToken).toBe(h.jobs.hook.webhookToken!);
    expect(((await h.ask("GET", `/automations/${h.jobs.hook.id}`)).body.automation as AutomationSummary).hook?.webhookToken).toBe(h.jobs.hook.webhookToken!);
  });

  test("missions: her own, the one that reports to her chat, and the one proposed there", async () => {
    const h = await house();
    expect(await h.names("/missions", "missions")).toEqual(["hers", "proposed", "to her"]);
    const listed = (await h.ask("GET", "/missions")).body.missions as (MissionView & { owner?: string })[];
    expect(Object.fromEntries(listed.map((one) => [one.goal, [one.person?.name ?? "-", one.changeable]]))).toEqual({ hers: ["Rina", true], "to her": ["Gading", false], proposed: ["-", true] });
    expect(listed.some((one) => "owner" in one)).toBe(false);
  });

  test("the runs she is shown are her jobs' runs", async () => {
    const h = await house();
    const run = (id: string) => db.prepare("INSERT INTO cron_runs (id, job_id, job_name, started_at, finished_at, status) VALUES (?, ?, ?, 1, 2, 'success')").run(`run_${id}`, id, id);
    run(h.jobs.hers.id);
    run(h.jobs.his.id);
    run("cron_gone");
    const seen = async () => ((await h.ask("GET", "/cron/runs")).body.runs as { jobId: string }[]).map((one) => one.jobId).sort();
    expect(await seen()).toEqual([h.jobs.hers.id]);
    as = "gading";
    expect(await seen()).toEqual([h.jobs.hers.id, h.jobs.his.id, "cron_gone"].sort());
  });

  test("a step that waits for a person is shown to whoever may answer it, and answered by them", async () => {
    const h = await house();
    h.waiting.push({ runId: "run_hers", jobId: h.jobs.hers.id }, { runId: "run_his", jobId: h.jobs.his.id }, { runId: "run_to_her", jobId: h.jobs.toHer.id });
    const shown = async () => ((await h.ask("GET", "/automations/waiting")).body.waiting as WaitingStep[]).map((one) => one.runId).sort();
    expect(await shown()).toEqual(["run_hers"]);
    expect((await h.ask("POST", "/automations/runs/run_his/answer", { go: true })).status).toBe(409);
    expect((await h.ask("POST", "/automations/runs/run_to_her/answer", { go: true })).status).toBe(409);
    expect(h.answered).toEqual([]);
    expect((await h.ask("POST", "/automations/runs/run_hers/answer", { go: true })).status).toBe(200);
    expect(h.answered).toEqual([{ run: "run_hers", go: true, by: "Rina" }]);
    as = "gading";
    expect(await shown()).toEqual(["run_hers", "run_his", "run_to_her"]);
  });
});

describe("an operator asking for another person's", () => {
  test("automation, by its id: not there, at every door, and nothing changed", async () => {
    const h = await house();
    const id = h.jobs.his.id;
    expect((await h.ask("GET", `/automations/${id}`)).status).toBe(404);
    expect((await h.ask("GET", `/cron/${id}`)).status).toBe(404);
    expect((await h.ask("POST", `/cron/${id}`, { name: "hers now" })).status).toBe(404);
    expect((await h.ask("POST", `/cron/${id}/allowed`, { add: { keys: ["chat:x"], label: "x" } })).status).toBe(404);
    expect((await h.ask("POST", `/cron/${id}/disable`)).status).toBe(404);
    expect((await h.ask("POST", `/cron/${id}/run`)).status).toBe(404);
    expect((await h.ask("DELETE", `/cron/${id}`)).status).toBe(404);
    // Whose it is is an admin's to set.
    expect((await h.ask("POST", `/cron/${id}/owner`, { person: "rina" })).status).toBe(403);
    expect(h.ran).toEqual([]);
    expect(h.store.get(id)).toMatchObject({ name: "his", enabled: true, owner: "web:u1" });
    expect(h.store.get(id)?.allowed).toBeUndefined();
    // And the answer is the one a job that is not there gets.
    expect((await h.ask("GET", `/cron/${id}`)).body).toEqual((await h.ask("GET", "/cron/cron_missing")).body);
  });

  test("webhook: its test is not hers to send either", async () => {
    const h = await house();
    expect((await h.ask("POST", `/webhooks/${h.jobs.hook.id}/test`)).status).toBe(404);
  });

  test("mission, by its id: not there, at every door, and nothing changed", async () => {
    const h = await house();
    const id = h.missions.his.id;
    expect((await h.ask("GET", `/missions/${id}`)).status).toBe(404);
    expect((await h.ask("POST", `/missions/${id}/edit`, { goal: "hers now" })).status).toBe(404);
    expect((await h.ask("POST", `/missions/${id}/stop`)).status).toBe(404);
    expect((await h.ask("POST", `/missions/${id}/tell`, { text: "stop that" })).status).toBe(404);
    expect((await h.ask("DELETE", `/missions/${id}`)).status).toBe(404);
    expect(h.h.missions.get(id)).toMatchObject({ goal: "his", owner: "telegram:814" });
    expect(["queued", "running"]).toContain(h.h.missions.get(id)!.status);
  });
});

describe("one that only reports to her chat", () => {
  test("an automation: read, with its runs, and not changed", async () => {
    const h = await house();
    const id = h.jobs.toHer.id;
    const read = await h.ask("GET", `/automations/${id}`);
    expect(read.status).toBe(200);
    expect((read.body.automation as AutomationSummary).changeable).toBe(false);
    expect(((await h.ask("GET", `/cron/${id}`)).body.job as JobSummary).person).toEqual({ key: "gading", name: "Gading" });
    expect((await h.ask("POST", `/cron/${id}`, { name: "mine" })).status).toBe(404);
    expect((await h.ask("POST", `/cron/${id}/allowed`, { add: { keys: ["chat:x"], label: "x" } })).status).toBe(404);
    expect((await h.ask("POST", `/cron/${id}/disable`)).status).toBe(404);
    expect((await h.ask("DELETE", `/cron/${id}`)).status).toBe(404);
    expect(h.store.get(id)).toMatchObject({ name: "to her", enabled: true });
  });

  test("a mission: read, and not stopped, told or deleted", async () => {
    const h = await house();
    const id = h.missions.toHer.id;
    const read = await h.ask("GET", `/missions/${id}`);
    expect(read.status).toBe(200);
    expect((read.body.mission as MissionView).changeable).toBe(false);
    expect((await h.ask("POST", `/missions/${id}/stop`)).status).toBe(404);
    expect((await h.ask("POST", `/missions/${id}/tell`, { text: "x" })).status).toBe(404);
    expect((await h.ask("DELETE", `/missions/${id}`)).status).toBe(404);
    expect(["queued", "running"]).toContain(h.h.missions.get(id)!.status);
  });
});

describe("her own", () => {
  test("an automation she makes is hers, and she changes, pauses, runs and deletes it", async () => {
    const h = await house();
    const made = await h.ask("POST", "/cron", { agentId: "nova", name: "new", every: "5m", payload: { kind: "systemEvent", text: "hi" }, target: HER_WEB });
    expect(made.status).toBe(200);
    const id = (made.body.job as JobSummary).id;
    expect(h.store.get(id)?.owner).toBe("web:u2");
    expect((made.body.job as JobSummary).person).toEqual({ key: "rina", name: "Rina" });
    expect((await h.ask("POST", `/cron/${id}`, { name: "renamed" })).status).toBe(200);
    expect((await h.ask("POST", `/cron/${id}/disable`)).status).toBe(200);
    expect((await h.ask("POST", `/cron/${id}/run`)).status).toBe(200);
    expect(h.ran).toEqual([id]);
    expect(h.store.get(id)).toMatchObject({ name: "renamed", enabled: false });
    expect((await h.ask("DELETE", `/cron/${id}`)).status).toBe(200);
    expect(h.store.get(id)).toBeNull();
  });

  test("one made from the command line is nobody's", async () => {
    const h = await house();
    as = "cli";
    const made = await h.ask("POST", "/cron", { agentId: "nova", name: "by line", every: "5m", payload: { kind: "systemEvent", text: "hi" }, target: HIS_CHAT });
    expect(h.store.get((made.body.job as JobSummary).id)?.owner).toBeUndefined();
  });

  test("a proposal made in her chat is hers to turn on, and becomes hers; she does not rewrite it first", async () => {
    const h = await house();
    const id = h.jobs.proposal.id;
    expect((await h.ask("POST", `/cron/${id}`, { name: "rewritten" })).status).toBe(404);
    expect((await h.ask("POST", `/cron/${id}/enable`)).status).toBe(200);
    expect(h.store.get(id)).toMatchObject({ enabled: true, owner: "web:u2", turnedOnBy: "u2", name: "proposed" });
    expect(h.store.get(id)?.proposal).toBeUndefined();
  });

  test("a change proposed in her chat to another person's automation is not hers to turn on; one to her own is", async () => {
    const h = await house();
    const change = (replaces: string, name: string) => h.store.create(job({ name, createdBy: "agent:nova", target: HER_WEB, proposal: proposalFor("nova", { ...HER_WEB, senderId: "u2" }, 1, replaces) }));

    // The admin's automation tells her chat, so she sees it, and the agent proposed a change to it there.
    const toHis = change(h.jobs.toHer.id, "to her, rewritten");
    // She sees the proposal, marked as not hers to answer, and every door that would answer it is closed to her.
    expect(((await h.ask("GET", `/automations/${toHis.id}`)).body.automation as AutomationSummary).changeable).toBe(false);
    expect((await h.ask("POST", `/cron/${toHis.id}/enable`)).status).toBe(404);
    expect((await h.ask("DELETE", `/cron/${toHis.id}`)).status).toBe(404);
    expect(h.store.get(h.jobs.toHer.id)).toMatchObject({ name: "to her", owner: "web:u1" });
    expect(h.store.get(toHis.id)?.proposal).toBeDefined();

    // A change to her own is hers.
    const toHers = change(h.jobs.hers.id, "hers, rewritten");
    expect((await h.ask("POST", `/cron/${toHers.id}/enable`)).status).toBe(200);
    expect(h.store.get(h.jobs.hers.id)).toMatchObject({ name: "hers, rewritten", owner: "web:u2" });

    // The admin says yes to the first: changed, and still the admin's.
    as = "gading";
    expect((await h.ask("POST", `/cron/${toHis.id}/enable`)).status).toBe(200);
    expect(h.store.get(h.jobs.toHer.id)).toMatchObject({ name: "to her, rewritten", owner: "web:u1" });
  });

  test("a mission she starts is hers; one an agent proposed in her chat becomes hers when she says yes", async () => {
    const h = await house();
    const started = await h.ask("POST", "/missions", { agent: "nova", goal: "Write the report in the folder" });
    expect(started.status).toBe(201);
    expect(h.h.missions.get((started.body.mission as MissionView).id)?.owner).toBe("web:u2");
    // Started on the dashboard to report to a chat on a chat app: the account's, not an id of hers on that platform.
    const elsewhere = await h.ask("POST", "/missions", { agent: "nova", goal: "Write the second report in the folder", gatewayId: HER_CHAT.gatewayId, chatId: HER_CHAT.chatId });
    expect(elsewhere.status).toBe(201);
    expect(h.h.missions.get((elsewhere.body.mission as MissionView).id)?.owner).toBe("web:u2");
    expect((await h.ask("POST", `/missions/${h.missions.hers.id}/stop`)).status).toBe(200);

    const proposed = h.missions.proposed.id;
    expect(h.h.missions.get(proposed)?.owner).toBeNull();
    expect((await h.ask("POST", `/missions/${proposed}/accept`)).status).toBe(200);
    expect(h.h.missions.get(proposed)?.owner).toBe("web:u2");
  });
});

describe("an admin", () => {
  test("sees their own first, and everyone's set apart by person when they ask, with nobody's last", async () => {
    const h = await house();
    as = "gading";
    expect(await h.names("/automations", "automations")).toEqual(["his", "hook", "nobody's", "to her"]);
    expect(await h.names("/automations?whose=everyone", "automations")).toEqual(["hers", "his", "hook", "nobody's", "proposed", "to her"]);
    expect(await h.names("/automations?whose=person:rina", "automations")).toEqual(["hers", "hook", "proposed", "to her"]);
    expect(await h.names("/automations?whose=unknown", "automations")).toEqual(["nobody's", "proposed"]);
    expect(await h.names("/missions?whose=everyone", "missions")).toEqual(["hers", "his", "proposed", "to her"]);
    expect(await h.names("/missions?whose=person:rina", "missions")).toEqual(["hers", "proposed", "to her"]);
    expect(await h.names("/missions?whose=unknown", "missions")).toEqual(["proposed"]);
  });

  test("is told how many more there are than their own, and nobody else is told anything", async () => {
    const h = await house();
    const elsewhere = async (path: string) => (await h.ask("GET", path)).body.elsewhere;
    as = "gading";
    // Six automations, four of them listed as the admin's own: the page opens on those, and says two more exist.
    expect(await elsewhere("/automations")).toBe(2);
    expect(await elsewhere("/missions")).toBe(2);
    // Asked for everyone's, one person's or nobody's, the list is what was asked for: nothing to add.
    for (const whose of ["everyone", "person:rina", "unknown"]) expect({ whose, said: await elsewhere(`/automations?whose=${whose}`) }).toEqual({ whose, said: undefined });
    expect(await elsewhere("/missions?whose=everyone")).toBeUndefined();
    // An operator sees all there is for her to see, and the command line's own is everyone's.
    as = "rina";
    expect(await elsewhere("/automations")).toBeUndefined();
    expect(await elsewhere("/missions")).toBeUndefined();
    as = "cli";
    expect(await elsewhere("/automations")).toBeUndefined();
  });

  test("changes anyone's, and hands one nobody owns to a person, or back to nobody", async () => {
    const h = await house();
    as = "gading";
    expect((await h.ask("POST", `/cron/${h.jobs.hers.id}/disable`)).status).toBe(200);
    expect((await h.ask("POST", `/missions/${h.missions.hers.id}/stop`)).status).toBe(200);

    const id = h.jobs.nobodys.id;
    const handed = await h.ask("POST", `/cron/${id}/owner`, { person: "rina" });
    expect(handed.status).toBe(200);
    expect((handed.body.job as JobSummary).person).toEqual({ key: "rina", name: "Rina" });
    expect(h.store.get(id)?.owner).toBe("web:u2");
    as = "rina";
    expect((await h.ask("POST", `/cron/${id}/disable`)).status).toBe(200);
    as = "gading";
    expect((await h.ask("POST", `/cron/${id}/owner`, { person: "budi" })).status).toBe(400);
    // Somebody People holds no id for: refused in words that say what to do, and it stays whose it was.
    expect(await h.ask("POST", `/cron/${id}/owner`, { person: "tamu" })).toMatchObject({ status: 400, body: { plain: "This person has no account and no chat app under their name in People yet, so nothing can be theirs. Add one for them in People first." } });
    expect(h.store.get(id)?.owner).toBe("web:u2");
    expect((await h.ask("POST", `/cron/${id}/owner`, {})).status).toBe(400);
    expect((await h.ask("POST", `/cron/${id}/owner`, { person: null })).status).toBe(200);
    expect(h.store.get(id)?.owner).toBeUndefined();
    expect((await h.ask("POST", "/cron/cron_missing/owner", { person: "rina" })).status).toBe(404);
  });

  test("the command line reads and changes every one", async () => {
    const h = await house();
    as = "cli";
    expect(await h.names("/automations", "automations")).toEqual(["hers", "his", "hook", "nobody's", "proposed", "to her"]);
    expect((await h.ask("POST", `/cron/${h.jobs.his.id}/disable`)).status).toBe(200);
  });
});

describe("a viewer", () => {
  test("with no person reads nothing of anyone's", async () => {
    const h = await house();
    as = "tamu";
    expect(await h.names("/automations", "automations")).toEqual([]);
    expect(await h.names("/missions", "missions")).toEqual([]);
    expect((await h.ask("GET", `/missions/${h.missions.hers.id}`)).status).toBe(404);
  });
});

/** The route files, and what a door asks with (`whose.ts`'s reader of things, and each file's own helper over it). */
const ROUTES = join(import.meta.dir, "../../src/modules/web/control/routes");
const ASKS = /\b(thingsFor|jobFor)\(/;
/** A path that names or lists an automation, a scheduled job, a webhook or a mission. */
const DOOR = /^\/(automations|cron|webhooks|missions)(\/|$)/;

describe("every door asks", () => {
  test("each route that names or lists an automation, a job, a webhook or a mission asks whose it is", () => {
    const doors: { route: string; asks: boolean }[] = [];
    for (const file of readdirSync(ROUTES).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(ROUTES, file), "utf8");
      const found = [...source.matchAll(/\bcontrol\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
      found.forEach((match, n) => {
        if (!DOOR.test(match[2]!)) return;
        const body = source.slice(match.index, found[n + 1]?.index ?? source.length);
        doors.push({ route: `${match[1]!.toUpperCase()} ${match[2]!}`, asks: ASKS.test(body) });
      });
    }
    // The table of the RFC and the hand-over, at least: a reader that stopped finding routes would pass anything.
    expect(doors.length).toBeGreaterThanOrEqual(23);
    expect(doors.filter((door) => !door.asks).map((door) => door.route)).toEqual([]);
  });
});
