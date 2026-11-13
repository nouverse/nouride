/**
 * The doors a job of steps is made and read through: the control API the Automations page uses, the `schedule` tool an
 * agent proposes one with and the card that says it in words, and a start by hand. What is held here is that each
 * door keeps a step as written, refuses what `validate.ts` refuses with the step named, and that nothing an agent
 * wrote runs until a person turns it on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { Hono } from "hono";
import type { AutomationSummary, JobRunSummary, WaitingStep } from "@nouride/wire";
import type { CronSection, Job, JobStep, ToolContext } from "@nouride/shared";
import { AuditLog } from "@/commons/audit.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { migrate } from "@/db/index.ts";
import { CronStore, type JobInput } from "@/modules/cron/cron.store.ts";
import { describeTrigger, parseScheduleInput } from "@/modules/cron/parse.ts";
import { proposalCard, turnOnProposal } from "@/modules/cron/proposals.ts";
import { CronScheduler, type CronExecutors } from "@/modules/cron/scheduler.ts";
import { cheapPasswords, eventually } from "../helpers.ts";

const CONFIG: CronSection = { ...DEFAULT_CONFIG.cron, minIntervalMs: 1000, maxJobs: 30 };
const START = Date.parse("2026-08-18T10:00:00Z");
const TOKEN = "control-token-for-tests-0000000000";

let dir: string;
let db: SqliteDb;
let store: CronStore;
let clock: number;

const say = (id: string, text: string): JobStep => ({ id, kind: "systemEvent", text });

function job(steps: JobStep[] | null, overrides: Partial<JobInput> = {}): Job {
  return store.create({
    agentId: "nouva",
    name: "weekly",
    trigger: { kind: "every", everyMs: 60_000 },
    payload: steps ? { kind: "steps", steps } : { kind: "systemEvent", text: "hello" },
    target: { gatewayId: "telegram:main", chatId: "12345" },
    createdBy: "tester",
    ...overrides,
  });
}

function scheduler(overrides: Partial<CronExecutors> = {}) {
  const delivered: string[] = [];
  const made = new CronScheduler({
    store,
    config: CONFIG,
    now: () => clock,
    executors: {
      runTurn: async () => ({ text: "turn output" }),
      dispatchTurn: () => true,
      deliver: async (_target, text) => (delivered.push(text), { ok: true }),
      commandSandbox: () => ({ cwd: dir, env: {} }),
      ...overrides,
    },
  });
  return { scheduler: made, delivered };
}

function control(made: CronScheduler = scheduler().scheduler, users: UserStore = new UserStore({ db })): Hono {
  const app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users,
    files: {},
    cron: { store, scheduler: made, timezone: "UTC" },
    registry: { get: (id: string) => (id === "nouva" || id === "nix" ? { dir: `/packs/${id}`, config: {} } : undefined), reload: async () => {} },
  } as unknown as ControlDeps);
  return app;
}
const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(
    `/api/control${path}`,
    { method, headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    { clientAddress: "203.0.113.10" },
  );
const read = async <T>(answer: Response | Promise<Response>): Promise<T> => (await (await answer).json()) as T;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-tmp-step-doors-"));
  db = openDatabase(join(dir, "t.db"));
  migrate(db);
  clock = START;
  store = new CronStore({ db, config: CONFIG, timezone: "UTC", now: () => clock });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a start by hand", () => {
  test("is a job with no time: never due, run when somebody starts it, and each of those runs counts", async () => {
    expect(parseScheduleInput({ manual: true }, START, "UTC")).toEqual({ kind: "manual" });
    expect(() => parseScheduleInput({ manual: true, every: "5m" }, START, "UTC")).toThrow("a job started by hand has no time");
    expect(describeTrigger({ kind: "manual" }, "UTC")).toBe("when somebody starts it");

    const made = job([say("a", "started")], { trigger: { kind: "manual" } });
    expect(made.nextRunAt).toBeUndefined();
    clock += 365 * 86_400_000;
    expect(store.due(clock)).toEqual([]);

    const { scheduler: runs, delivered } = scheduler();
    expect(await runs.runNow(made.id, "tester")).toMatchObject({ status: "success" });
    expect(delivered).toEqual(["started"]);
    // Its only kind of run: counted, where a forced run of a scheduled job is not.
    expect(store.get(made.id)).toMatchObject({ runCount: 1, enabled: true });
    expect(store.get(made.id)!.nextRunAt).toBeUndefined();
  });

  test("a scheduled job keeps its time when run by hand, and counts nothing for it", async () => {
    const made = job([say("a", "x")]);
    const { scheduler: runs } = scheduler();
    await runs.runNow(made.id, "tester");
    expect(store.get(made.id)).toMatchObject({ runCount: 0, nextRunAt: START + 60_000 });
  });

  test("the control API makes one and turns a schedule into one", async () => {
    const app = control();
    const made = await read<{ job: Job }>(call(app, "POST", "/cron", { agentId: "nouva", name: "on demand", manual: true, payload: { kind: "steps", steps: [{ kind: "systemEvent", text: "x" }] }, target: { gatewayId: "telegram:main", chatId: "1" } }));
    expect(made.job.trigger).toEqual({ kind: "manual" });
    const scheduled = job([say("a", "x")]);
    const changed = await read<{ job: Job }>(call(app, "POST", `/cron/${scheduled.id}`, { manual: true }));
    expect(changed.job.trigger).toEqual({ kind: "manual" });
    expect(changed.job.nextRunAt).toBeUndefined();
  });
});

describe("the Automations page's routes", () => {
  test("one list of every job, whatever starts it, each with how it starts, its address, its newest run and a change that waits", async () => {
    const scheduled = job([say("a", "x")]);
    const hook = job(null, { name: "on push", trigger: { kind: "webhook" } });
    const manual = job([say("a", "x")], { name: "on demand", trigger: { kind: "manual" } });
    const suggested = job([say("a", "x"), say("b", "y")], { name: "weekly", proposal: { by: "nouva", gatewayId: "telegram:main", chatId: "12345", for: "8142", at: START, replaces: scheduled.id } });
    const { scheduler: runs } = scheduler();
    await runs.runNow(manual.id, "tester");

    const { automations, timezone } = await read<{ automations: AutomationSummary[]; timezone: string }>(call(control(runs), "GET", "/automations"));
    const by = (id: string) => automations.find((one) => one.id === id)!;

    expect(timezone).toBe("UTC");
    expect(automations.map((one) => one.id).sort()).toEqual([scheduled.id, hook.id, manual.id, suggested.id].sort());
    expect([by(scheduled.id).start, by(hook.id).start, by(manual.id).start]).toEqual(["scheduled", "webhook", "manual"]);
    expect(by(scheduled.id).describes).toBe("every 1m");
    expect(by(manual.id).describes).toBe("when somebody starts it");
    // A webhook's address goes with it; the others have none.
    expect(by(hook.id).hook).toMatchObject({ path: `/hooks/${hook.webhookToken}`, webhookToken: hook.webhookToken });
    expect(by(scheduled.id).hook).toBeUndefined();
    expect(by(manual.id).lastRun).toMatchObject({ status: "success" });
    expect(by(scheduled.id).lastRun).toBeUndefined();
    // The change an agent proposed is named on the job it would change, and is listed as the proposal it is.
    expect(by(scheduled.id).suggested).toBe(suggested.id);
    expect(by(suggested.id).proposal?.replaces).toBe(scheduled.id);
    expect(by(suggested.id).enabled).toBe(false);
  });

  test("one automation with its runs and the steps of each, and the change that waits for it", async () => {
    const made = job([say("a", "first"), say("b", "second")], { trigger: { kind: "manual" } });
    const suggested = job([say("a", "first")], { proposal: { by: "nouva", gatewayId: "telegram:main", chatId: "12345", for: "8142", at: START, replaces: made.id } });
    const { scheduler: runs } = scheduler();
    await runs.runNow(made.id, "tester");

    const app = control(runs);
    const page = await read<{ automation: AutomationSummary; runs: JobRunSummary[]; suggested?: AutomationSummary }>(call(app, "GET", `/automations/${made.id}`));
    expect(page.automation).toMatchObject({ id: made.id, start: "manual", suggested: suggested.id });
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]!.steps?.map((step) => [step.id, step.status, step.said])).toEqual([["a", "done", "first"], ["b", "done", "second"]]);
    expect(page.suggested?.id).toBe(suggested.id);
    expect((await call(app, "GET", "/automations/cron_missing")).status).toBe(404);
    // `waiting` is a list of its own, not a job called that.
    expect((await call(app, "GET", "/automations/waiting")).status).toBe(200);
  });

  test("a step that waits for a person is listed with what it asks, and answered once from here", async () => {
    const made = job([{ id: "draft", kind: "command", argv: ["sh", "-c", "printf 'the draft'"] }, { id: "ok", kind: "approval", ask: "Send it?" }, say("sent", "Sent.")], { trigger: { kind: "manual" } });
    const { scheduler: runs, delivered } = scheduler();
    const app = control(runs);
    expect((await read<{ waiting: WaitingStep[] }>(call(app, "GET", "/automations/waiting"))).waiting).toEqual([]);

    await runs.runNow(made.id, "tester");
    const { waiting } = await read<{ waiting: WaitingStep[] }>(call(app, "GET", "/automations/waiting"));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ jobId: made.id, jobName: "weekly", agentId: "nouva", ask: "Send it?", said: "the draft", since: START });
    const runId = waiting[0]!.runId;
    // The run on its page says the same: it waits, at that step.
    const page = await read<{ runs: JobRunSummary[] }>(call(app, "GET", `/automations/${made.id}`));
    expect(page.runs[0]).toMatchObject({ status: "waiting", waiting: { kind: "approval", step: "ok" } });

    expect((await call(app, "POST", `/automations/runs/${runId}/answer`, { go: "yes" })).status).toBe(400);
    expect((await call(app, "POST", `/automations/runs/${runId}/answer`, { go: true })).status).toBe(200);
    await eventually(() => store.runs(made.id)[0]!.finishedAt !== undefined, 4_000, "the run to end");
    expect(delivered).toEqual(["Sent."]);
    expect((await read<{ waiting: WaitingStep[] }>(call(app, "GET", "/automations/waiting"))).waiting).toEqual([]);

    const again = await call(app, "POST", `/automations/runs/${runId}/answer`, { go: true });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "That is not waiting any more." });
  });

  test("only a step that waits for a person is listed and answered: not one that waits for a mission, and not by a viewer", async () => {
    const asks = job([{ id: "ok", kind: "approval", ask: "Go?" }], { trigger: { kind: "manual" } });
    const works = job([{ id: "fix", kind: "mission", goal: "Fix it." }], { name: "works", trigger: { kind: "manual" } });
    const { scheduler: runs } = scheduler({ startMission: () => ({ started: "msn_1" }), missionEnd: () => ({ working: true }) });
    await runs.runNow(asks.id, "tester");
    await runs.runNow(works.id, "tester");
    const users = new UserStore({ db, passwords: cheapPasswords });
    await users.create({ username: "vic", password: "viewer-password-1", role: "viewer", createdBy: "test" });
    const app = control(runs, users);

    const { waiting } = await read<{ waiting: WaitingStep[] }>(call(app, "GET", "/automations/waiting"));
    expect(waiting.map((one) => one.jobId)).toEqual([asks.id]);

    const login = await app.request("/api/control/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "vic", password: "viewer-password-1" }) }, { clientAddress: "203.0.113.10" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const refused = await app.request(`/api/control/automations/runs/${waiting[0]!.runId}/answer`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ go: true }) }, { clientAddress: "203.0.113.10" });
    expect(refused.status).toBe(403);
    expect(store.runs(asks.id)[0]!.status).toBe("waiting");
  });

  test("the route keeps each step as written, gives one with no id an id, and refuses with the step named", async () => {
    const app = control();
    const body = (steps: unknown[]) => ({ agentId: "nouva", name: "weekly", cron: "0 9 * * 1", payload: { kind: "steps", steps }, target: { gatewayId: "telegram:main", chatId: "1" } });
    const answer = await call(app, "POST", "/cron", body([
      { kind: "command", argv: ["sh", "-lc", "gh issue list"], whenEmpty: "next" },
      { id: "sum", kind: "agentTurn", message: "Sum up.", agentId: "nix", name: "Sum up", whenFailed: { to: "tell" } },
      { id: "ok", kind: "approval", ask: "Send it?", timeoutMs: 3_600_000 },
      { id: "tell", kind: "systemEvent", text: "Done." },
    ]));
    expect(answer.status).toBe(200);
    const { job: made } = (await answer.json()) as { job: Job };
    expect(made.payload).toEqual({
      kind: "steps",
      steps: [
        { id: "s1", whenEmpty: "next", kind: "command", argv: ["sh", "-lc", "gh issue list"] },
        { id: "sum", name: "Sum up", whenFailed: { to: "tell" }, kind: "agentTurn", message: "Sum up.", agentId: "nix" },
        { id: "ok", kind: "approval", ask: "Send it?", timeoutMs: 3_600_000 },
        { id: "tell", kind: "systemEvent", text: "Done." },
      ],
    });

    const said = async (steps: unknown[]) => {
      const refused = await call(app, "POST", "/cron", body(steps));
      return [refused.status, (await refused.json()) as { error: string; plain?: string }] as const;
    };
    // A command's `then` as a job of one command has it is not an exit of a step: refused, not quietly dropped.
    expect((await said([{ kind: "command", argv: ["date"], then: "agentTurn" }]))[1].error).toBe('step 1: `then` is "next", "end", or { to: the id of a later step }.');
    expect((await said([{ kind: "steps", steps: [] }]))[1].error).toBe("step 1 must be a message, an agent's turn, a command, a mission or a wait for a person.");
    const [status, ghost] = await said([{ kind: "mission", goal: "x", agentId: "ghost" }]);
    expect(status).toBe(400);
    expect(ghost.error).toBe('step 1: no agent "ghost": a step must name one that exists');
    // A refusal names the field as the page's form does.
    expect((await said([]))[1].plain).toContain("the steps");
    const changed = await call(app, "POST", `/cron/${job([say("a", "x")]).id}`, { payload: { kind: "steps", steps: [{ kind: "agentTurn", message: "x", agentId: "ghost" }] } });
    expect(changed.status).toBe(400);
  });
});

describe("an agent proposes a list", () => {
  function tool(agents = ["nouva", "nix"]) {
    const posted: Job[] = [];
    const made = createScheduleTool({ chats: () => ({ chats: [], othersGateways: [] }), store, timezone: () => "UTC", agentExists: (id) => agents.includes(id), post: async (proposed) => (posted.push(proposed), true) });
    const ctx = { agentId: "nouva", gatewayId: "telegram:main", chatId: "8142", senderId: "8142", workspaceRoots: [] } as unknown as ToolContext;
    return { propose: (args: Record<string, unknown>) => made.execute({ name: "weekly", when: "cron 0 9 * * 1", ...args }, ctx), posted, made };
  }

  test("written as it writes a job of one kind, with exits by step number, a wait for a person, and another agent", async () => {
    const { propose, posted } = tool();
    const answer = await propose({
      steps: [
        { name: "Check the shop", command: "curl -sf https://shop.example.com/health", then: "end", if_failed: "next" },
        { prompt: "The shop is down: find out why.", agent: "nix", if_empty: 4 },
        { ask: "Restart the shop?" },
        { mission: "Restart the shop and confirm it answers.", agent: "nix" },
      ],
    });

    expect(answer.isError).toBe(false);
    const proposed = posted[0]!;
    expect(proposed.enabled).toBe(false);
    expect(proposed.payload).toEqual({
      kind: "steps",
      steps: [
        { id: "s1", name: "Check the shop", then: "end", whenFailed: "next", kind: "command", argv: ["sh", "-lc", "curl -sf https://shop.example.com/health"] },
        { id: "s2", whenEmpty: { to: "s4" }, kind: "agentTurn", message: "The shop is down: find out why.", agentId: "nix" },
        { id: "s3", kind: "approval", ask: "Restart the shop?" },
        { id: "s4", kind: "mission", goal: "Restart the shop and confirm it answers.", agentId: "nix" },
      ],
    });
    expect(answer.content).toContain("It stays off until a person turns it on from its card here");
  });

  test("the card says each step in order, and where the run goes from it when that is not simply the next", async () => {
    const { propose, posted } = tool();
    await propose({
      steps: [
        { command: "curl -sf https://shop.example.com/health", then: "end", if_failed: "next" },
        { prompt: "The shop is down: find out why.", agent: "nix", if_empty: 4 },
        { ask: "Restart the shop?" },
        { mission: "Restart the shop.", agent: "nix" },
      ],
    });
    const card = proposalCard(posted[0]!, "cron 0 9 * * 1", { buttons: true });
    expect(card).toContain("Does: in order, each handed what the one before said:");
    expect(card).toContain("1. runs `sh -lc curl -sf https://shop.example.com/health` on this machine, with no model Once done, the run ends there. If it fails, the run goes to step 2. With nothing to say, the run ends there.");
    expect(card).toContain('2. nix works on: "The shop is down: find out why." With nothing to say, the run goes to step 4.');
    expect(card).toContain('3. waits for a person\'s yes to: "Restart the shop?" On a no, or no answer, the run ends.');
    expect(card).toContain('4. a mission for nix: "Restart the shop.", then a reviewer agrees');
    expect(card).toContain("It stays off until somebody turns it on.");
  });

  test("one started by hand is proposed with `manual`, and its card says when it runs", async () => {
    const { propose, posted } = tool();
    expect((await propose({ when: "manual", steps: [{ text: "Started." }] })).isError).toBe(false);
    expect(posted[0]!.trigger).toEqual({ kind: "manual" });
    const card = proposalCard(posted[0]!, "", { buttons: true });
    expect(card).toContain("proposes work started by hand: **weekly**");
    expect(card).toContain("When: when somebody presses Run now");
  });

  test("a change to a running job's steps is a proposal beside it, and the job takes it once a person says yes", async () => {
    const running = job([{ id: "collect", kind: "agentTurn", message: "Collect." }]);
    const { propose, posted } = tool();
    const answer = await propose({ replaces: running.id, when: "every 1m", steps: [{ command: "date", if_empty: "next" }, { prompt: "Collect." }] });
    expect(answer.isError).toBe(false);
    // Nothing changed yet: the job runs its old list until the card is answered.
    expect(store.get(running.id)!.payload).toEqual({ kind: "steps", steps: [{ id: "collect", kind: "agentTurn", message: "Collect." }] });

    const turned = turnOnProposal(store, posted[0]!.id, { actor: "Gading", as: "8142" });
    expect("job" in turned && turned.job.id).toBe(running.id);
    expect(store.get(running.id)!.payload).toEqual({
      kind: "steps",
      steps: [{ id: "s1", whenEmpty: "next", kind: "command", argv: ["sh", "-lc", "date"] }, { id: "s2", kind: "agentTurn", message: "Collect." }],
    });
    expect(store.get(posted[0]!.id)).toBeNull();
  });

  test("the tool refuses a list beside one thing, a step with two things or none, an unknown agent, a jump back, and a command on a webhook", async () => {
    const { propose } = tool();
    expect((await propose({ text: "hi", steps: [{ prompt: "x" }] })).content).toBe("Give `steps`, or one of `text`, `command`, `prompt` and `mission`: not both.");
    expect((await propose({ steps: [] })).content).toBe("`steps` is a list of at least one step.");
    expect((await propose({ steps: [{ prompt: "x" }, { prompt: "y", text: "z" }] })).content).toBe("Step 2: Give exactly one of `text`, `command`, `prompt`, `mission` or `ask`.");
    expect((await propose({ steps: [{ name: "nothing" }] })).content).toBe("Step 1: Give exactly one of `text`, `command`, `prompt`, `mission` or `ask`.");
    expect((await propose({ steps: [{ prompt: "x", agent: "ghost" }] })).content).toBe("Step 1: there is no agent called ghost.");
    expect((await propose({ steps: [{ prompt: "x" }, { prompt: "y", then: 1 }] })).content).toBe("Not proposed: step 2: `then` points at step 1, which is not after it. A run only goes forward.");
    expect((await propose({ when: "webhook", steps: [{ prompt: "x" }, { command: "date" }] })).content).toBe("A webhook that runs a command is made by an admin from the dashboard, not proposed.");
    // What a step's agent is woken with is working text, in English, as a job's own prompt is.
    expect((await propose({ steps: [{ prompt: "Rangkum semua isu yang masih terbuka minggu ini untuk tim." }] })).content).toStartWith("Step 1: ");
    // A question a person reads is theirs, in their own language.
    expect((await propose({ steps: [{ prompt: "Draft the reply." }, { ask: "Kirim balasan ini ke pelanggan sekarang?" }] })).isError).toBe(false);
  });
});
