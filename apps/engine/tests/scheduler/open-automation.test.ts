/**
 * An agent changes the automation a person has open on its page (`cron/open-automation.ts`, `schedule` with
 * `replaces: "open"`): what the page holds is said in the tool's own words, the agent writes it back whole with its
 * change, and the change is checked as a save is, held for the page, and written nowhere.
 *
 * Each case is a way it would lose somebody's work or go round a rule: a field the tool has no word for dropped on
 * the way back, a step taken for another, a job made or a card posted for what is only a draft, a start that is past
 * refused though nobody changed it, a change that is not whole drawn all the same, or a webhook made from a chat.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { AutomationChange, JobStep, LiveEdit, Tool, ToolContext } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { automationKind, commandLine, openSaid, readOpen, sameStart } from "@/modules/cron/open-automation.ts";
import { stepsFrom } from "@/modules/cron/step-input.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import type { ReachableChat, SendTargets } from "@/modules/tools/builtins/send-message.ts";

type Raw = Record<string, unknown>;

/** What the page sends: its draft as it would save it, with how it starts and what it keeps between runs beside it. */
const STEPS: Raw[] = [
  { id: "s1", kind: "command", argv: ["python3"], script: { text: "print('mail')", about: "Fetches unread mail", secrets: ["MAIL_TOKEN"] }, cwd: "/work/mail", timeoutMs: 60_000, whenFailed: { to: "s4" }, whenEmpty: "end" },
  { id: "s2", kind: "agentTurn", message: "Sum up the mail in five lines.", model: "claude-sonnet-5-5", agentId: "nox", onlyChanged: true },
  { id: "s3", kind: "approval", ask: "Send it to the family group?", timeoutMs: 3_600_000, whenFailed: "end", then: "end" },
  { id: "s4", kind: "systemEvent", text: "Could not read the mail today.", name: "Say it failed" },
];
const BODY: Raw = {
  agentId: "nouva",
  name: "Morning email summary",
  start: "scheduled",
  cron: "0 7 * * 1-5",
  tz: "Asia/Jakarta",
  payload: { kind: "steps", steps: STEPS },
  target: { gatewayId: "telegram:nouva", chatId: "8142" },
  delivery: { mode: "announce", atOnce: true },
  session: "fresh",
};
/** That automation as `schedule` writes it. */
const SAID = {
  name: "Morning email summary",
  when: "cron 0 7 * * 1-5",
  tz: "Asia/Jakarta",
  steps: [
    { id: "s1", script: "print('mail')", run: "python3", about: "Fetches unread mail", secrets: ["MAIL_TOKEN"], if_failed: 4, if_empty: "end" },
    { id: "s2", prompt: "Sum up the mail in five lines.", agent: "nox", only_changed: true },
    { id: "s3", ask: "Send it to the family group?", then: "end", if_failed: "end" },
    { id: "s4", name: "Say it failed", text: "Could not read the mail today." },
  ],
};

const here: ReachableChat = { gatewayId: "web:dashboard", chatId: "web-1", platform: "web", kind: "dm", people: [{ key: "gading", name: "Gading" }], lastActive: 300 };
const telegram: ReachableChat = { gatewayId: "telegram:nouva", chatId: "8142", platform: "telegram", kind: "dm", people: [{ key: "gading", name: "Gading" }], lastActive: 200 };
const family: ReachableChat = { gatewayId: "whatsapp:nouva", chatId: "1203@g.us", platform: "whatsapp", kind: "group", title: "Keluarga Besar", people: [{ name: "Mira" }], lastActive: 100 };
const chats = (): SendTargets => ({ chats: [here, telegram, family], othersGateways: [] });

const NOW = Date.parse("2026-11-24T02:00:00Z");
let dir = "";
let db: SqliteDb;
let store: CronStore;
let posted: number;
let offers: { kind: string; target: string | null; value: AutomationChange; by: string; gatewayId: string; chatId: string; senderId: string }[];
let tool: Tool;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "open-automation-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  store = new CronStore({ db, config: DEFAULT_CONFIG.cron, timezone: "Asia/Jakarta", now: () => NOW });
  posted = 0;
  offers = [];
  tool = createScheduleTool({
    store,
    timezone: () => "Asia/Jakarta",
    agentExists: (id) => id === "nouva" || id === "nox",
    post: async () => ((posted += 1), true),
    chats,
    proposeLiveEdit: (offer) => (offers.push(offer), `edit_${offers.length}`),
    now: () => NOW,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (liveEdit?: LiveEdit): ToolContext =>
  ({ agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1", gateway: "web", senderId: "usr_1", workspaceRoots: [], ...(liveEdit ? { liveEdit } : {}) }) as unknown as ToolContext;
const OPEN = (value: Raw = BODY, id: string | null = "cron_open"): LiveEdit => ({ kind: "automation", id, value });
const change = (args: Raw, open = OPEN()) => tool.execute({ ...args, replaces: "open" }, ctx(open));
const jobs = () => store.list({ includeDisabled: true });
/** A list of steps as a save keeps it: the same reader the page's own save goes through. */
const saved = (steps: Raw[]): JobStep[] => stepsFrom(steps);

describe("what the turn reads", () => {
  test("is the automation in the tool's own words: its start, each step by what it does, its paths by a step's number", () => {
    expect(openSaid(readOpen(BODY)!, { agentId: "nouva" })).toEqual(SAID);
    expect(automationKind.said(OPEN(), { agentId: "nouva" })).toEqual(SAID);
    expect(automationKind.tool).toBe("schedule");
  });

  test("names its agent only when that is not the agent reading, as the tool's `agent` means another one", () => {
    expect(openSaid(readOpen(BODY)!, { agentId: "nox" }).agent).toBe("nouva");
    expect("agent" in openSaid(readOpen(BODY)!, { agentId: "nouva" })).toBe(false);
  });

  test("a job of one thing is that thing, and a start by hand, by its address, or not written yet is said as that", () => {
    const one = (payload: Raw, more: Raw = {}) => openSaid(readOpen({ ...BODY, cron: undefined, tz: undefined, every: "15m", payload, ...more })!, { agentId: "nouva" });
    expect(one({ kind: "agentTurn", message: "Read the news." })).toEqual({ name: "Morning email summary", when: "every 15m", prompt: "Read the news." });
    expect(one({ kind: "command", argv: ["sh", "-lc", "df -h | tail -3"], then: "agentTurn" })).toMatchObject({ command: "df -h | tail -3" });
    expect(one({ kind: "systemEvent", text: "Stand up!" }, { start: "manual", every: undefined })).toEqual({ name: "Morning email summary", when: "manual", text: "Stand up!" });
    expect(one({ kind: "mission", goal: "Audit the backups.", checks: ["test -f report.md"], review: false, draft: true }, { start: "webhook", every: undefined })).toEqual({
      name: "Morning email summary",
      when: "webhook",
      mission: "Audit the backups.",
      checks: ["test -f report.md"],
      no_review: true,
      draft: true,
    });
    // Nothing written for when it starts: said without one, and the agent's `when` is then a start, not a repeat.
    expect("when" in one({ kind: "agentTurn", message: "x" }, { every: undefined })).toBe(false);
  });

  test("a draft is half a thought: one with nothing in it yet, or a step with nothing written, is said as it is", () => {
    // A page that makes a new one, before anything is written: a list with no steps yet.
    expect(openSaid(readOpen({ name: "", agentId: "nouva", start: "scheduled", payload: { kind: "steps", steps: [] } })!, { agentId: "nouva" })).toEqual({ name: "", steps: [] });
    expect(openSaid(readOpen({})!, { agentId: "nouva" })).toEqual({ name: "" });
    expect(openSaid(readOpen({ name: "New", payload: { kind: "steps", steps: [{ id: "s1", kind: "agentTurn", message: "" }, { id: "s2", kind: "command", argv: [] }] } })!, { agentId: "nouva" })).toEqual({
      name: "New",
      steps: [{ id: "s1", prompt: "" }, { id: "s2", command: "" }],
    });
    for (const no of [null, undefined, "words", 7, []]) expect(readOpen(no)).toBeNull();
  });

  test("several at the same time, its marks and how long it lasts", () => {
    const said = openSaid(
      readOpen({
        ...BODY,
        payload: { kind: "steps", steps: [{ id: "s1", kind: "parallel", steps: [{ id: "s1-1", kind: "agentTurn", message: "Check the shop.", agentId: "nox", name: "Shop" }, { id: "s1-2", kind: "command", argv: ["sh", "-lc", "uptime"] }] }] },
        delivery: { mode: "announce", once: true, lasts: 6 * 3_600_000 },
      })!,
      { agentId: "nouva" },
    );
    expect(said.steps).toEqual([{ id: "s1", together: [{ name: "Shop", prompt: "Check the shop.", agent: "nox" }, { command: "uptime" }] }]);
    expect(said).toMatchObject({ once: true, for: "6h" });
  });

  test("a line of arguments is the shell line it is, or each part quoted where a shell would split it", () => {
    expect(commandLine(["sh", "-lc", "a && b"])).toBe("a && b");
    expect(commandLine(["python3", "check.py", "--fast"])).toBe("python3 check.py --fast");
    expect(commandLine(["echo", "two words", "it's"])).toBe("echo 'two words' 'it'\\''s'");
  });

  test("two starts that say the same are the same, whatever their spaces and case; one not written is like no other", () => {
    expect(sameStart("cron 0 7 * * 1-5", "CRON  0 7 * * 1-5 ")).toBe(true);
    expect(sameStart("cron 0 7 * * 1-5", "cron 0 8 * * 1-5")).toBe(false);
    expect(sameStart(null, null)).toBe(false);
    expect(sameStart("manual", null)).toBe(false);
  });
});

describe("written back as it was read, nothing is lost", () => {
  test("every field the tool has no word for is on the step it was on: a model, a folder, a time limit", async () => {
    const result = await change(SAID);
    expect(result).toMatchObject({ isError: false, liveEdit: "edit_1" });
    expect(offers[0]!.value.payload).toEqual({ kind: "steps", steps: saved(STEPS) });
  });

  test("a job of one thing keeps what its one thing had: a lone command's hand-over to its agent, where it runs", async () => {
    const body = { ...BODY, payload: { kind: "command", argv: ["python3", "check.py", "--fast"], cwd: "/srv/shop", timeoutMs: 30_000, then: "agentTurn" } };
    const said = openSaid(readOpen(body)!, { agentId: "nouva" });
    expect(said.command).toBe("python3 check.py --fast");
    await change(said, OPEN(body));
    expect(offers[0]!.value.payload).toEqual({ kind: "command", argv: ["python3", "check.py", "--fast"], cwd: "/srv/shop", timeoutMs: 30_000, then: "agentTurn" });
    // Its line changed, it is the shell line the agent wrote; where it runs and for how long are still the step's.
    await change({ ...said, command: "python3 check.py --slow" }, OPEN(body));
    expect(offers[1]!.value.payload).toEqual({ kind: "command", argv: ["sh", "-lc", "python3 check.py --slow"], cwd: "/srv/shop", timeoutMs: 30_000, then: "agentTurn" });
  });

  test("a walk over many automations: each said, written back untouched, and the same as a save would keep it", async () => {
    // A small generator with its own seed: the same automations every run, so a failure names one that can be read.
    let seed = 20261124;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const pick = <T,>(of: readonly T[]): T => of[rand(of.length)]!;
    const maybe = <T extends Raw>(extra: T): T | Raw => (rand(2) === 0 ? extra : {});
    const part = (id: string, agent?: string): Raw =>
      rand(2) === 0
        ? { id, kind: "agentTurn", message: `Look at ${id}.`, ...maybe({ model: "gemini-3.8-flash" }), ...(agent ? { agentId: agent } : {}), ...maybe({ name: `Part ${id}` }) }
        : { id, kind: "command", argv: pick([["sh", "-lc", `echo ${id}`], ["uptime"], ["python3", "x.py", "two words"]]), ...maybe({ cwd: "/srv" }), ...maybe({ timeoutMs: 5_000 }) };
    for (let round = 0; round < 300; round += 1) {
      const count = 1 + rand(6);
      const ids = Array.from({ length: count }, (_, at) => pick([`s${at + 1}`, `step_${round}_${at}`, `k${at}x`]));
      const steps = ids.map((id, at): Raw => {
        const later = ids.slice(at + 1);
        const go = () => (later.length > 0 && rand(3) === 0 ? { to: pick(later) } : pick(["next", "end"] as const));
        const exits = { ...maybe({ then: go() }), ...maybe({ whenFailed: go() }), ...maybe({ whenEmpty: go() }) };
        const kind = pick(["systemEvent", "agentTurn", "command", "script", "mission", "approval", "parallel"] as const);
        const named = maybe({ name: `Step ${at + 1} of ${round}` });
        switch (kind) {
          case "systemEvent":
            return { id, kind, text: `Say ${at}.`, ...named, ...exits };
          case "agentTurn":
            return { id, kind, message: `Do ${at}.`, ...maybe({ model: "claude-sonnet-5-5" }), ...maybe({ agentId: "nox" }), ...maybe({ onlyChanged: true }), ...named, ...exits };
          case "command":
            return { id, kind, argv: pick([["sh", "-lc", `df -h | head -${at + 1}`], ["python3", "check.py", `--n=${at}`], ["echo", "two words"]]), ...maybe({ cwd: "/srv/shop" }), ...maybe({ timeoutMs: 30_000 }), ...maybe({ onlyChanged: true }), ...named, ...exits };
          case "script":
            return { id, kind: "command", argv: pick([["sh"], ["python3"], ["bun", "run"]]), script: { text: `print(${at})\n# two\tlines`, about: `Counts to ${at}`, ...maybe({ secrets: ["A_TOKEN", "B_KEY"] }) }, ...maybe({ cwd: "/srv" }), ...maybe({ timeoutMs: 9_000 }), ...named, ...exits };
          case "mission":
            return { id, kind, goal: `Audit ${at}.`, ...maybe({ checks: ["test -f a", "true"] }), ...pick([{}, { review: false }, { review: "It names every disk." }]), ...maybe({ draft: true }), ...maybe({ agentId: "nox" }), ...named, ...exits };
          case "approval":
            return { id, kind, ask: `Go on with ${at}?`, ...maybe({ timeoutMs: 600_000 }), ...named, ...exits };
          case "parallel":
            return { id, kind, steps: [part(`${id}-1`, "nox"), part(`${id}-2`)], ...named, ...exits };
        }
      });
      const body = { ...BODY, payload: { kind: "steps", steps } };
      const said = openSaid(readOpen(body)!, { agentId: "nouva" });
      const result = await change(said, OPEN(body));
      if (result.isError) throw new Error(`round ${round}: ${result.content}\n${JSON.stringify(said, null, 1)}`);
      expect({ round, payload: offers.at(-1)!.value.payload }).toEqual({ round, payload: { kind: "steps", steps: saved(steps) } });
    }
    // And through all of it nothing was made and nothing posted.
    expect(jobs()).toEqual([]);
    expect(posted).toBe(0);
  });
});

describe("a change", () => {
  test("to one step's words keeps that step's own model, by its id, and the others as they were", async () => {
    const steps = SAID.steps.map((step) => (step.id === "s2" ? { ...step, prompt: "Sum up the mail in three lines, most urgent first." } : step));
    await change({ ...SAID, steps });
    const [, second] = (offers[0]!.value.payload as { steps: JobStep[] }).steps;
    expect(second).toEqual({ id: "s2", kind: "agentTurn", message: "Sum up the mail in three lines, most urgent first.", model: "claude-sonnet-5-5", agentId: "nox", onlyChanged: true });
    expect((offers[0]!.value.payload as { steps: JobStep[] }).steps.filter((_, at) => at !== 1)).toEqual(saved(STEPS).filter((_, at) => at !== 1));
  });

  test("a new step has no id and is given one nobody has; the steps after it keep theirs, and a path's number is its place now", async () => {
    const steps = [SAID.steps[0]!, { prompt: "Drop the newsletters." }, ...SAID.steps.slice(1)].map((step) => ("if_failed" in step && step.if_failed === 4 ? { ...step, if_failed: 5 } : step));
    await change({ ...SAID, steps });
    const written = (offers[0]!.value.payload as { steps: JobStep[] }).steps;
    expect(written.map((step) => step.id)).toEqual(["s1", "s2x", "s2", "s3", "s4"]);
    expect(written[1]).toEqual({ id: "s2x", kind: "agentTurn", message: "Drop the newsletters." });
    // The path that led to the step that says it failed still leads there, by its id.
    expect(written[0]!.whenFailed).toEqual({ to: "s4" });
    expect(written[2]).toEqual(saved(STEPS)[1]!);
  });

  test("a step that changes its kind keeps its id and nothing of the kind it was", async () => {
    const steps = SAID.steps.map((step) => (step.id === "s2" ? { id: "s2", command: "wc -l mail.txt" } : step.id === "s3" ? { id: "s3", command: "send.sh" } : step));
    await change({ ...SAID, steps });
    expect((offers[0]!.value.payload as { steps: JobStep[] }).steps[1]).toEqual({ id: "s2", kind: "command", argv: ["sh", "-lc", "wc -l mail.txt"] });
    // A wait's hour for an answer is not the time a command may run for: the two share a field's name and nothing else.
    expect((offers[0]!.value.payload as { steps: JobStep[] }).steps[2]).toEqual({ id: "s3", kind: "command", argv: ["sh", "-lc", "send.sh"] });
  });

  test("an id nobody has, or one written twice, is a new step's: the first keeps it, and nothing is carried to the other", async () => {
    const steps = [{ id: "s2", prompt: "First." }, { id: "s2", prompt: "Second." }, { id: "made_up", prompt: "Third." }];
    await change({ ...SAID, steps });
    expect((offers[0]!.value.payload as { steps: JobStep[] }).steps).toEqual([
      { id: "s2", kind: "agentTurn", message: "First.", model: "claude-sonnet-5-5" },
      { id: "s2x", kind: "agentTurn", message: "Second." },
      { id: "s3", kind: "agentTurn", message: "Third." },
    ]);
  });

  test("makes no job and posts no card: it is held for the page, with whose it is, and the agent is told so", async () => {
    const result = await change(SAID);
    expect(jobs()).toEqual([]);
    expect(posted).toBe(0);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ kind: "automation", target: "cron_open", by: "nouva", gatewayId: "web:dashboard", chatId: "web-1", senderId: "usr_1" });
    expect(result.content).toBe(
      "Drawn on the page they have open, over what they have there. Nothing is saved and nothing is on: they apply it on the page, and save it when they are ready. Say what you changed in one line; do not ask them again.",
    );
    expect(result.page).toBeUndefined();
    // One being made has no id, and is the page's that makes one.
    await change(SAID, OPEN(BODY, null));
    expect(offers[1]!.target).toBeNull();
  });

  test("keeps where it reports, what it keeps between runs and its marks, unless `to`, `once` or `for` says otherwise", async () => {
    await change(SAID);
    expect(offers[0]!.value).toMatchObject({ name: "Morning email summary", agentId: "nouva", target: { gatewayId: "telegram:nouva", chatId: "8142" }, delivery: { mode: "announce", atOnce: true }, session: "fresh" });
    await change({ ...SAID, name: "Mail, mornings", to: "Keluarga Besar", once: true, for: "30d" });
    expect(offers[1]!.value).toMatchObject({ name: "Mail, mornings", delivery: { mode: "announce", atOnce: true, once: true, lasts: 30 * 86_400_000, gatewayId: "whatsapp:nouva", chatId: "1203@g.us" } });
    // A chat it was sent to before stays, and the instant it ends on is never a caller's to write.
    const elsewhere = { ...BODY, delivery: { mode: "announce", gatewayId: "whatsapp:nouva", chatId: "1203@g.us", lasts: 3_600_000 * 48, endsAt: 99 }, session: "isolated" };
    const moved = await change(SAID, OPEN(elsewhere));
    expect(moved.content).toStartWith("Drawn on the page");
    expect(offers[2]!.value.delivery).toEqual({ mode: "announce", lasts: 3_600_000 * 48, gatewayId: "whatsapp:nouva", chatId: "1203@g.us" });
    expect(offers[2]!.value.session).toBe("isolated");
    // `to` naming the chat it reports from already is no other chat.
    await change({ ...SAID, to: "telegram:nouva:8142" }, OPEN(elsewhere));
    expect("gatewayId" in offers[3]!.value.delivery).toBe(false);
    const nowhere = await change({ ...SAID, to: "a chat nobody has" });
    expect(nowhere.isError).toBe(true);
    expect(nowhere.content).toStartWith("`to` names no chat its results could go to.");
  });

  test("written whole: a mark the agent leaves off is off, and how long it lasts stays unless another length is said", async () => {
    const watch = { ...BODY, cron: undefined, tz: undefined, every: "10m", delivery: { mode: "announce", once: true, lasts: 6 * 3_600_000 } };
    const said = openSaid(readOpen(watch)!, { agentId: "nouva" });
    expect(said).toMatchObject({ once: true, for: "6h" });
    await change(said, OPEN(watch));
    expect(offers[0]!.value.delivery).toEqual({ mode: "announce", once: true, lasts: 6 * 3_600_000 });
    // "Keep telling me": the agent writes it without `once`.
    const { once: _once, ...goesOn } = said;
    await change(goesOn, OPEN(watch));
    expect(offers[1]!.value.delivery).toEqual({ mode: "announce", lasts: 6 * 3_600_000 });
    await change({ ...said, for: "2d" }, OPEN(watch));
    expect(offers[2]!.value.delivery).toEqual({ mode: "announce", once: true, lasts: 2 * 86_400_000 });
    // And the rule a proposal is held to holds here: told once on a clock, it needs an end.
    const endless = await change({ ...SAID, once: true });
    expect(endless.content).toStartWith("`once` on a schedule needs `for`");
  });

  test("one made on a page with no chat picked yet reports to the chat it was asked in", async () => {
    await change(SAID, OPEN({ ...BODY, target: { gatewayId: "", chatId: "" } }, null));
    expect(offers[0]!.value.target).toEqual({ gatewayId: "web:dashboard", chatId: "web-1" });
  });
});

describe("how it starts", () => {
  const once = { ...BODY, cron: undefined, tz: undefined, at: "2026-01-05 09:00" };
  const saidOnce = () => openSaid(readOpen(once)!, { agentId: "nouva" });

  test("left as it is, it is the page's own and is not held to the clock again: a moment already past stays", async () => {
    expect(saidOnce().when).toBe("at 2026-01-05 09:00");
    const result = await change(saidOnce(), OPEN(once));
    expect(result.isError).toBe(false);
    expect("starts" in offers[0]!.value).toBe(false);
    // The same start said with other spaces is still not a change.
    await change({ ...saidOnce(), when: "AT  2026-01-05 09:00" }, OPEN(once));
    expect("starts" in offers[1]!.value).toBe(false);
  });

  test("changed, it is held to the clock as a save holds it, and handed to the page as its new start", async () => {
    const past = await change({ ...saidOnce(), when: "at 2026-01-06 09:00" }, OPEN(once));
    expect(past).toEqual({ content: "Not drawn on the page: that time has already passed.", isError: true });
    expect(offers).toEqual([]);
    await change({ ...saidOnce(), when: "every 30m" }, OPEN(once));
    expect(offers[0]!.value.starts).toEqual({ start: "scheduled", trigger: { kind: "every", everyMs: 30 * 60_000 } });
    await change({ ...SAID, when: "manual" });
    expect(offers[1]!.value.starts).toEqual({ start: "manual", trigger: { kind: "manual" } });
    // Another zone for the same pattern is another start.
    await change({ ...SAID, tz: "Asia/Tokyo" });
    expect(offers[2]!.value.starts).toEqual({ start: "scheduled", trigger: { kind: "cron", expr: "0 7 * * 1-5", tz: "Asia/Tokyo" } });
    const tooOften = await change({ ...SAID, when: "every 1s" });
    expect(tooOften.content).toStartWith("Not drawn on the page: the shortest interval allowed is");
  });

  test("one that exists starts by its address or it does not: that is changed on its page, not from a chat", async () => {
    const hook = { ...BODY, start: "webhook", cron: undefined, tz: undefined, payload: { kind: "steps", steps: [{ id: "s1", kind: "command", argv: ["sh", "-lc", "deploy.sh"] }] } };
    const said = openSaid(readOpen(hook)!, { agentId: "nouva" });
    expect(said.when).toBe("webhook");
    // Its steps changed, a command among them: the person who saves it is the one whose rights that takes.
    const kept = await change({ ...said, steps: [...(said.steps as Raw[]), { text: "Deployed." }] }, OPEN(hook));
    expect(kept.isError).toBe(false);
    const refusal = "Whether it starts when its address is called is changed on its page, not from here: keep `when` as it is.";
    expect(await change({ ...said, when: "every 1h" }, OPEN(hook))).toEqual({ content: refusal, isError: true });
    expect(await change({ ...SAID, when: "webhook" })).toEqual({ content: refusal, isError: true });
    // One being made is whatever the person saves it as.
    expect((await change({ ...SAID, when: "webhook", steps: [{ prompt: "Read the call." }] }, OPEN(BODY, null))).isError).toBe(false);
  });
});

describe("what is not a whole automation is not drawn", () => {
  test("refused in the words a save's refusal has, to the agent, with nothing held for the page", async () => {
    const empty = await change({ ...SAID, steps: [{ id: "s1", prompt: "  " }] });
    expect(empty.isError).toBe(true);
    const forward = await change({ ...SAID, steps: [{ prompt: "One." }, { prompt: "Two.", then: 1 }] });
    expect(forward.isError).toBe(true);
    expect(forward.content).toStartWith("Not drawn on the page: ");
    const nameless = await change({ ...SAID, name: " " });
    expect(nameless).toEqual({ content: "Give it a `name`.", isError: true });
    expect(offers).toEqual([]);
    expect(jobs()).toEqual([]);
  });
});

describe("which calls change what is open", () => {
  test("`open`, or the open one's own id; any other call proposes as it always did", async () => {
    await tool.execute({ ...SAID, replaces: "cron_open" }, ctx(OPEN()));
    expect(offers).toHaveLength(1);
    expect(jobs()).toEqual([]);
    // No `replaces`: another automation, proposed, with its card, though one is open.
    const { steps: _steps, ...rest } = SAID;
    const proposed = await tool.execute({ ...rest, name: "Another one", prompt: "Read the news." }, ctx(OPEN()));
    expect(proposed.content).toStartWith("Proposed as cron_");
    expect(jobs()).toHaveLength(1);
    expect(posted).toBe(1);
    expect(offers).toHaveLength(1);
    // A change to some other job goes the way it always went: here, refused, since there is no such job.
    expect((await tool.execute({ ...rest, prompt: "x", replaces: "cron_other" }, ctx(OPEN()))).content).toBe("There is no job cron_other to change.");
  });

  test("`open` with nothing open, a page of another kind, or a chat that cannot draw on a page is refused in words", async () => {
    const nothing = 'Nothing is open on a page to change: `replaces: "open"` is for the automation a person has open in the dashboard, asked from the chat over that page. Name the job it changes, or leave `replaces` out.';
    expect(await tool.execute({ ...SAID, replaces: "open" }, ctx())).toEqual({ content: nothing, isError: true });
    expect(await tool.execute({ ...SAID, replaces: "open" }, ctx({ kind: "mission", id: "msn_1", value: {} }))).toEqual({ content: nothing, isError: true });
    expect(await change(SAID, { kind: "automation", id: "cron_open", value: null, tooLong: 61_234 })).toEqual({
      content: "The automation they have open is too long to change from this chat (61234 characters). Say so: they change it on the page itself.",
      isError: true,
    });
    const deaf = createScheduleTool({ store, timezone: () => "Asia/Jakarta", agentExists: () => true, post: async () => true, chats, now: () => NOW });
    expect((await deaf.execute({ ...SAID, replaces: "open" }, ctx(OPEN()))).content).toBe("This chat cannot draw a change on a page. Propose it with `replaces` naming the job instead.");
    expect(jobs()).toEqual([]);
  });
});

describe("the words that make an agent change what is open", () => {
  test("say which call, that it is written whole with each step's id, that nothing is stored, and never a second automation", () => {
    expect(automationKind.how).toContain('call `schedule` with `replaces: "open"` and all of it as it should be');
    expect(automationKind.how).toContain("every step, changed or not, each one you keep with its `id` and a new one with none");
    expect(automationKind.how).toContain("Nothing is stored and nothing is turned on");
    expect(automationKind.how).toContain("they apply it there and save it when they are ready");
    expect(automationKind.how).toContain("A change to this one is never a second automation proposed beside it.");
  });

  test("a step's `id` is a field the tool takes, so a model that follows the schema can write it back", () => {
    const step = (tool.definition.parameters as { properties: { steps: { items: { properties: Record<string, unknown> } } } }).properties.steps.items.properties;
    expect(step.id).toEqual({ type: "string" });
  });
});
