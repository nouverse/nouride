/**
 * Scheduled work an agent proposes and a person turns on (0.8.0): the `schedule` tool writes the job whole and keeps it
 * off; its card says what it does, when and where; a press, `/schedule on|discard` or the dashboard answers it, by the
 * rule approvals keep for who may — and an agent never turns one on itself, nor makes one through `nouride cron add`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { ButtonPress, Gateway, MessageButton, PressAnswer, Tool, ToolContext } from "@nouride/shared";
import type { HookContext } from "@/modules/hooks/types.ts";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { ProposalCards } from "@/modules/cron/proposal-cards.ts";
import { proposalCard } from "@/modules/cron/proposals.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { createNourideCliTool } from "@/modules/tools/builtins/nouride-cli.ts";
import { routePresses } from "@/modules/gateways/presses.ts";
import { scheduleHooks } from "@/modules/hooks/builtins/schedule.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

let dir = "";
let db: SqliteDb;
let store: CronStore;
let asked: { target: { gatewayId: string; chatId: string }; text: string; buttons: MessageButton[] }[];
let settled: { messageId: string; text: string }[];
let cards: ProposalCards;
let tool: Tool;
const ADMINS = new Set(["admin-7"]);

const DM = { agentId: "nouva", gatewayId: "telegram:main", chatId: "8142", senderId: "8142", workspaceRoots: [] } as unknown as ToolContext;
const ROOM = { agentId: "nouva", gatewayId: "telegram:main", chatId: "-100team", senderId: "8142" } as ToolContext;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "proposals-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  store = new CronStore({ db, config: DEFAULT_CONFIG.cron, timezone: "Asia/Jakarta" });
  asked = [];
  settled = [];
  cards = new ProposalCards({
    store,
    notifier: {
      ask: async (target, text, buttons) => (asked.push({ target, text: text(true), buttons }), { ids: [`m${asked.length}`], buttons: true }),
      settle: async (_target, messageId, text) => (settled.push({ messageId, text }), true),
    },
    voice: (_agentId, gatewayId) => gatewayId,
    isAdmin: (who) => ADMINS.has(who.senderId),
    when: (job) => (job.trigger.kind === "cron" ? `cron ${job.trigger.expr}` : job.trigger.kind),
  });
  tool = createScheduleTool({ store, timezone: () => "Asia/Jakarta", agentExists: (id) => id === "nouva" || id === "nox", post: (job) => cards.post(job) });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const propose = (args: Record<string, unknown>, ctx: ToolContext = DM) => tool.execute({ name: "Jemput Mira", when: "cron 30 11 * * 1-4", text: "Jemput Mira jam 11:45", ...args }, ctx);
const press = (data: string, who: Partial<ButtonPress> = {}): ButtonPress => ({ gatewayId: "telegram:main", chatId: "8142", chatType: "dm", messageId: "m1", data, senderId: "8142", senderName: "Gading", ...who });
const only = () => store.list({ includeDisabled: true })[0]!;

describe("proposing", () => {
  test("the tool tells the model when to reach for it, the cheapest kind first, and that a person turns it on", () => {
    const words = tool.definition.description;
    expect(words).toContain("Use it for anything asked at a time or again and again.");
    expect(words).toContain("It stays off until a person turns it on from the card this posts here. Say so in one line.");
    expect(words).toContain("The cheapest that does the job: `text` is sent as written");
    expect(words).toContain("propose it again with `replaces`");
  });

  test("writes the job whole and keeps it off, posts its card here, and tells the agent it waits for a person", async () => {
    const result = await propose({});
    expect(result.isError).toBe(false);
    expect(result.content).toContain("stays off until a person turns it on from its card here");
    const job = only();
    expect(job).toMatchObject({
      enabled: false,
      name: "Jemput Mira",
      trigger: { kind: "cron", expr: "30 11 * * 1-4" },
      payload: { kind: "systemEvent", text: "Jemput Mira jam 11:45" },
      target: { gatewayId: "telegram:main", chatId: "8142" },
      createdBy: "agent:nouva",
      proposal: { by: "nouva", gatewayId: "telegram:main", chatId: "8142", for: "8142" },
    });
    expect(job.nextRunAt).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.target).toEqual({ gatewayId: "telegram:main", chatId: "8142" });
    expect(asked[0]!.buttons.map((button) => button.label)).toEqual(["Turn on", "Discard"]);
  });

  test("each kind reads as what it does on its card — a command whole, a mission with how it is judged", async () => {
    await propose({ name: "idle", text: undefined, command: "scripts/idle.sh --off", when: "cron 0 1-9 * * *" });
    await propose({ name: "report", text: undefined, prompt: "Report the server's health." });
    await propose({ name: "mail", text: undefined, mission: "Sum up the customer mail.", checks: ["test -s summary.md"], no_review: true, when: "cron 0 9 * * 1" });
    const texts = asked.map((one) => one.text);
    expect(texts[0]).toContain("Does: runs `sh -lc scripts/idle.sh --off` on this machine, with no model");
    expect(texts[1]).toContain('Does: nouva works on: "Report the server\'s health."');
    expect(texts[2]).toContain('Does: a mission for nouva: "Sum up the customer mail.", done when `test -s summary.md` pass, no reviewer');
    expect(texts[2]).toContain("It stays off until somebody turns it on.");
    // Without buttons, the card says the words that answer it.
    const job = store.list({ includeDisabled: true }).find((one) => one.name === "mail")!;
    expect(proposalCard(job, "every Monday", { buttons: false })).toContain(`Turn on: /schedule on ${job.id}`);
    expect(texts[2]).toContain("proposes a scheduled job: **mail**");
  });

  test("a proposed webhook is called one on its card, and its URL waits until it is on", async () => {
    await propose({ name: "issues", when: "webhook" });
    expect(asked.at(-1)!.text).toContain("proposes a webhook: **issues**");
    expect(asked.at(-1)!.text).toContain("When: a request to its own URL, shown once it is on");
  });

  test("refused: not exactly one thing to do, a webhook that runs a command, a chat nobody reads, an agent that is not there", async () => {
    expect((await propose({ prompt: "and this" })).content).toContain("exactly one of");
    expect((await propose({ text: undefined, command: "ls", when: "webhook" })).content).toContain("made by an admin from the dashboard");
    expect((await propose({}, { ...DM, gatewayId: "web:mission", chatId: "msn_1" } as ToolContext)).content).toContain("nobody reads this conversation");
    expect((await propose({}, { ...DM, chatId: "cron:cron_1" } as ToolContext)).content).toContain("nobody reads this conversation");
    expect((await propose({ agent: "ghost" })).content).toContain("no agent called ghost");
    expect((await propose({ when: "cron not a cron" })).content).toStartWith("Not proposed:");
    expect((await propose({ when: "tomorrow" })).content).toContain("`when` starts with");
    expect(store.list({ includeDisabled: true })).toEqual([]);
  });

  test("ten waiting is the most: a person answers those first", async () => {
    for (let i = 0; i < 10; i += 1) expect((await propose({ name: `r${i}` })).isError).toBe(false);
    expect((await propose({ name: "r10" })).content).toContain("10 of your proposals are waiting already");
  });

  test("the ten are counted by who proposed them, not by the agent that would run them", async () => {
    // Counted by the runner, one agent filed proposals for another without end — the jobs' ceiling, and the other's ten.
    for (let i = 0; i < 10; i += 1) expect((await propose({ name: `r${i}`, agent: "nox" })).isError).toBe(false);
    expect((await propose({ name: "r10", agent: "nox" })).content).toContain("10 of your proposals are waiting already");
    expect((await propose({ name: "own" }, { ...DM, agentId: "nox" } as ToolContext)).isError).toBe(false);
  });
});

describe("answering", () => {
  test("a press on Turn on turns it on, running as whoever pressed; the card is settled by the press", async () => {
    await propose({});
    const job = only();
    const answer = await cards.press(press(`job:on:${job.id}`));
    expect(answer).toEqual({ notice: "Turned on.", settled: "✅ **Jemput Mira** turned on by Gading." });
    expect(store.get(job.id)).toMatchObject({ enabled: true, turnedOnBy: "8142" });
    expect(store.get(job.id)?.proposal).toBeUndefined();
    expect(store.get(job.id)?.nextRunAt).toBeGreaterThan(0);
    // The press settles its own card: nothing rewrites it a second time.
    expect(settled).toEqual([]);
  });

  test("Discard lets it go; a late press says it is no longer waiting", async () => {
    await propose({});
    const job = only();
    expect(await cards.press(press(`job:no:${job.id}`))).toEqual({ notice: "Discarded.", settled: "🗑 **Jemput Mira** discarded by Gading." });
    expect(store.get(job.id)).toBeNull();
    expect((await cards.press(press(`job:on:${job.id}`))).notice).toBe("That proposal is no longer waiting.");
  });

  test("in a room, only the person it was proposed for or an admin; never from another chat", async () => {
    await propose({}, ROOM);
    const job = only();
    const inRoom = { chatId: "-100team", chatType: "group" as const };
    expect((await cards.press(press(`job:on:${job.id}`, { ...inRoom, senderId: "5555" }))).notice).toContain("Only the person it was proposed for, or an admin");
    expect((await cards.press(press(`job:on:${job.id}`, { senderId: "8142" }))).notice).toBe("That proposal was not made here.");
    expect(store.get(job.id)?.enabled).toBe(false);
    expect((await cards.press(press(`job:on:${job.id}`, { ...inRoom, senderId: "admin-7", senderName: "Admin" }))).notice).toBe("Turned on.");
    expect(store.get(job.id)?.turnedOnBy).toBe("admin-7");
  });

  test("a change takes the shape of the job it replaces — keeping its id and runs — and the proposal goes", async () => {
    const live = store.create({ agentId: "nouva", name: "report", trigger: { kind: "cron", expr: "0 7 * * *" }, payload: { kind: "agentTurn", message: "old" }, target: { gatewayId: "telegram:main", chatId: "8142" }, createdBy: "cli" });
    store.settle(live, { status: "success" });
    expect((await propose({ name: "report", text: undefined, prompt: "new", when: "cron 0 8 * * *", replaces: live.id })).isError).toBe(false);
    expect(asked.at(-1)!.text).toContain(`a change to job ${live.id}`);
    const proposal = store.list({ includeDisabled: true }).find((one) => one.proposal)!;
    expect((await cards.press(press(`job:on:${proposal.id}`))).notice).toBe("Turned on.");
    expect(store.get(proposal.id)).toBeNull();
    expect(store.get(live.id)).toMatchObject({ trigger: { kind: "cron", expr: "0 8 * * *" }, payload: { kind: "agentTurn", message: "new" }, runCount: 1, turnedOnBy: "8142" });
    // A change cannot make a schedule a webhook, nor name a job that is not there.
    expect((await propose({ text: undefined, prompt: "x", when: "webhook", replaces: live.id })).content).toContain("keeps the job's trigger");
    expect((await propose({ replaces: "cron_gone" })).content).toContain("There is no job cron_gone");
  });

  test("a change to another agent's job, or to one that reports to another chat, is an admin's to turn on", async () => {
    // An agent asked in a person's DM must not rewrite a job it does not run, or one whose results go to another chat:
    // the job would keep its agent and its chat's readers, running what this person said yes to.
    const noxs = store.create({ agentId: "nox", name: "digest", trigger: { kind: "cron", expr: "0 9 * * *" }, payload: { kind: "agentTurn", message: "Digest." }, target: { gatewayId: "telegram:main", chatId: "8142" }, createdBy: "admin" });
    const teams = store.create({ agentId: "nouva", name: "team", trigger: { kind: "cron", expr: "0 9 * * *" }, payload: { kind: "agentTurn", message: "Team." }, target: { gatewayId: "telegram:main", chatId: "-100team" }, createdBy: "admin" });
    for (const replaced of [noxs, teams]) {
      expect((await propose({ name: replaced.name, text: undefined, prompt: "Something else.", when: "cron 0 9 * * *", replaces: replaced.id })).isError).toBe(false);
      const proposal = store.list({ includeDisabled: true }).find((one) => one.proposal)!;
      expect((await cards.press(press(`job:on:${proposal.id}`))).notice).toBe("It changes a job of another agent, or one that reports to another chat: only an admin can turn that on.");
      expect(store.get(replaced.id)).toMatchObject({ agentId: replaced.agentId, payload: replaced.payload, target: replaced.target });
      expect(store.get(replaced.id)?.turnedOnBy).toBeUndefined();
      expect(store.get(proposal.id)?.proposal).toBeDefined();
      // An admin may: a change an admin reads is one they could have made.
      expect((await cards.press(press(`job:on:${proposal.id}`, { senderId: "admin-7", senderName: "Admin" }))).notice).toBe("Turned on.");
      expect(store.get(replaced.id)).toMatchObject({ payload: { kind: "agentTurn", message: "Something else." }, turnedOnBy: "admin-7" });
    }
  });

  test("a change turned on takes back what the job it replaces was allowed always", async () => {
    // What was allowed was a yes to the old job's shape; nobody said yes to the new one sending there.
    const live = store.create({ agentId: "nouva", name: "report", trigger: { kind: "cron", expr: "0 7 * * *" }, payload: { kind: "agentTurn", message: "old" }, target: { gatewayId: "telegram:main", chatId: "8142" }, createdBy: "cli" });
    store.allow(live.id, { keys: ["chat:telegram:main:-100finance"], label: "the finance chat" }, "admin");
    store.allow(live.id, { keys: ["host:x.example"], label: "x.example" }, "admin");
    expect((await propose({ name: "report", text: undefined, prompt: "new", when: "cron 0 8 * * *", replaces: live.id })).isError).toBe(false);
    const proposal = store.list({ includeDisabled: true }).find((one) => one.proposal)!;
    expect((await cards.press(press(`job:on:${proposal.id}`))).notice).toBe("Turned on.");
    expect(store.get(live.id)?.allowed).toBeUndefined();
  });

  test("`/schedule on <id>` answers it in words, where a chat has no buttons", async () => {
    await propose({});
    const job = only();
    const hook = scheduleHooks[0]!;
    const ctx = (args: string[]) =>
      ({ args, gatewayId: "telegram:main", chatId: "8142", senderId: "8142", envelope: { chatType: "dm", senderName: "Gading" }, deps: { proposals: cards } }) as unknown as HookContext;
    expect((await hook.handler(ctx(["maybe"])))?.reply).toContain("/schedule on <id>");
    expect((await hook.handler(ctx(["on", job.id])))?.reply).toBe("✅ Jemput Mira turned on by Gading.");
    expect(store.get(job.id)?.enabled).toBe(true);
  });

  test("a webhook is an admin's to turn on from a chat, as it is on the dashboard", async () => {
    await propose({ name: "issues", when: "webhook" });
    const job = only();
    expect((await cards.press(press(`job:on:${job.id}`))).notice).toBe("A webhook is an admin's to turn on, as making one is.");
    expect(store.get(job.id)?.enabled).toBe(false);
    expect((await cards.press(press(`job:on:${job.id}`, { senderId: "admin-7", senderName: "Admin" }))).notice).toBe("Turned on.");
  });

  test("an agent's bot never answers one — not even one asked for it, through `/schedule on`", async () => {
    // One agent's turn records its bot as who asked, then has the bot post `@nox /schedule on <id>`: the hook ran it as
    // that person's answer, and a job was on with nobody there.
    const hook = scheduleHooks[0]!;
    await propose({}, { ...ROOM, senderId: "bot-nox" } as ToolContext);
    const job = only();
    for (const verb of ["on", "discard"]) {
      const ctx = { args: [verb, job.id], gatewayId: "telegram:main", chatId: "-100team", senderId: "bot-nox", envelope: { chatType: "group", senderName: "Nox", senderIsBot: true }, deps: { proposals: cards } } as unknown as HookContext;
      expect((await hook.handler(ctx))?.reply).toBe("Only a person answers a proposal.");
    }
    expect(store.get(job.id)?.enabled).toBe(false);
  });

  test("presses go to whoever owns their data — a proposal's card, an approval's prompt — and an unknown one says so", async () => {
    let handler: ((press: ButtonPress) => Promise<PressAnswer>) | undefined;
    const gateway = { onPress: (fn: typeof handler) => void (handler = fn) } as unknown as Gateway;
    const approvals = { owns: (data: string) => data.startsWith("approval:"), press: async () => ({ notice: "approval" }) };
    routePresses([gateway], [approvals, cards]);
    await propose({});
    expect((await handler!(press("approval:once:apr_1"))).notice).toBe("approval");
    expect((await handler!(press(`job:on:${only().id}`))).notice).toBe("Turned on.");
    expect((await handler!(press("something:else"))).notice).toBe("That button is not one I know any more.");
  });
});

describe("an agent never schedules directly", () => {
  test("`nouride cron add|update|enable` and `webhook add|rotate` are refused, pointing at `schedule`", async () => {
    const exec = { definition: { name: "exec", description: "", parameters: {} }, requiresApproval: true, gate: () => ({ action: "run", via: "ceiling" }), execute: async () => ({ content: "ran", isError: false }) } as unknown as Tool;
    const cli = createNourideCliTool({ exec, installDir: "/srv/nouride", command: "/srv/nouride/nouride" });
    for (const args of [["cron", "add", "--name", "x"], ["cron", "update", "cron_1"], ["cron", "enable", "cron_1"], ["webhook", "add"], ["webhooks", "rotate", "cron_1"]]) {
      expect(cli.gate!({ args }, DM)).toMatchObject({ action: "refuse", reason: expect.stringContaining("propose one with `schedule`") });
      expect((await cli.execute({ args }, DM)).content).toContain("propose one with `schedule`");
    }
    // Reading, pausing and removing are not making or widening anything.
    for (const args of [["cron"], ["cron", "disable", "cron_1"], ["cron", "rm", "cron_1"], ["webhook"]]) expect(cli.gate!({ args }, DM).action).toBe("run");
  });
});

describe("from the dashboard", () => {
  const TOKEN = "control-token-for-tests-0000000000";
  function control(): Hono {
    const app = new Hono();
    mountControlRoutes(app, {
      ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
      token: TOKEN,
      audit: new AuditLog(db),
      users: new UserStore({ db }),
      files: {},
      cron: { store, scheduler: { runNow: async () => ({ status: "success" }) }, timezone: "UTC", proposals: cards },
      registry: { get: () => ({ dir: "/packs/nouva", config: {} }), reload: async () => {} },
    } as unknown as ControlDeps);
    return app;
  }
  const call = (app: Hono, path: string, method = "POST") => app.request(`/api/control${path}`, { method, headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });

  test("enable turns a proposal on and its card says so; run waits until it is on; delete discards it", async () => {
    await propose({});
    const job = only();
    const app = control();
    expect((await call(app, `/cron/${job.id}/run`)).status).toBe(409);
    const res = await call(app, `/cron/${job.id}/enable`);
    expect(res.status).toBe(200);
    expect(store.get(job.id)).toMatchObject({ enabled: true });
    expect(store.get(job.id)?.proposal).toBeUndefined();
    expect(settled.at(-1)?.text).toContain("turned on by");

    await propose({ name: "other" });
    const other = store.list({ includeDisabled: true }).find((one) => one.proposal)!;
    expect((await call(app, `/cron/${other.id}`, "DELETE")).status).toBe(200);
    expect(settled.at(-1)?.text).toContain("**other** discarded by");
  });
});

