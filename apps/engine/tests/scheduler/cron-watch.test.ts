/**
 * Automations that watch: a step that goes on only when what it said has changed, a webhook's body on a command's
 * standard input, a job that turns itself off once it has told, and the install's quiet hours.
 *
 * The executors are doubles, as in `cron-steps.test.ts`; commands are real ones, run by `sh`. A run "on its own time"
 * is started here as a webhook's call is (`runNow` with a trigger), which is a run nobody started by hand.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { formatQuietHours, isQuiet, minutesToQuietEnd, parseQuietHours, type CronSection, type Job, type JobStep, type JobTarget } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { CronStore, type JobInput, type RunState } from "@/modules/cron/cron.store.ts";
import { WEBHOOK_PAYLOAD } from "@/modules/cron/prompts.ts";
import { Quiet } from "@/modules/cron/quiet.ts";
import { CronScheduler, TOLD, type CronExecutors, type JobTurnRequest, type JobTurnResult } from "@/modules/cron/scheduler.ts";
import { stepsFrom } from "@/modules/cron/step-input.ts";
import type { MissionEnd } from "@/modules/missions/job-runs.ts";
import { cronInputFrom } from "@/modules/web/control/payloads.ts";
import { APPROVAL_WAIT_MS } from "@/modules/cron/steps.ts";
import { WatchStore } from "@/modules/cron/watch.store.ts";
import { eventually } from "../wait.ts";

const DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-cron-watch-"));

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

/** Noon, and three in the morning the night after: outside and inside `22:00-07:00` in UTC. */
const NOON = Date.parse("2026-08-18T12:00:00Z");
const NIGHT = Date.parse("2026-08-19T03:10:00Z");
const MORNING = Date.parse("2026-08-19T07:00:00Z");

let db: SqliteDb;
let store: CronStore;
let watch: WatchStore;
let clock: number;
let hours: string;

type Marks = Pick<JobStep, "then" | "whenFailed" | "whenEmpty" | "name" | "onlyChanged">;
const sh = (id: string, line: string, marks: Marks = {}): JobStep => ({ id, kind: "command", argv: ["sh", "-c", line], ...marks });
const ask = (id: string, message: string, marks: Marks = {}): JobStep => ({ id, kind: "agentTurn", message, ...marks });
const say = (id: string, text: string): JobStep => ({ id, kind: "systemEvent", text });
const wait = (id: string, question: string): JobStep => ({ id, kind: "approval", ask: question });

/** A daemon's hands, recorded. `answers`: what each turn says, in order; the last is repeated. */
function hands(answers: JobTurnResult[] = [{ text: "turn output" }], overrides: Partial<CronExecutors> = {}) {
  const delivered: { target: JobTarget; text: string }[] = [];
  const turns: JobTurnRequest[] = [];
  const dispatched: string[] = [];
  const asked: { runId: string; question: string; shown: string; until: number }[] = [];
  const executors: CronExecutors = {
    runTurn: async (request) => {
      turns.push(request);
      return answers[Math.min(turns.length, answers.length) - 1]!;
    },
    dispatchTurn: (_job, message) => {
      dispatched.push(message);
      return true;
    },
    deliver: async (target, text) => {
      delivered.push({ target, text });
      return { ok: true };
    },
    commandSandbox: () => ({ cwd: DIR, env: {} }),
    ask: async (_job, runId, step, shown, until) => {
      asked.push({ runId, question: step.ask, shown, until });
      return { gatewayId: "telegram:main", chatId: "12345", messageId: `card${asked.length}` };
    },
    ...overrides,
  };
  const quiet = new Quiet({ hours: () => hours, timeZone: () => "UTC", now: () => clock });
  const scheduler = new CronScheduler({ store, config: CONFIG, executors, watch, quiet, now: () => clock, maxSleepMs: 5 });
  /** A run on the job's own time: as a webhook's call starts one, which nobody started by hand. */
  const due = (id: string, body?: string) => scheduler.runNow(id, "hook", body === undefined ? {} : { body });
  return { scheduler, delivered, turns, dispatched, asked, due, said: () => delivered.map((one) => one.text) };
}

function job(steps: JobStep[], overrides: Partial<JobInput> = {}): Job {
  return store.create({
    agentId: "nouva",
    name: "disk watch",
    trigger: { kind: "webhook" },
    payload: { kind: "steps", steps },
    target: { gatewayId: "telegram:main", chatId: "12345" },
    createdBy: "tester",
    ...overrides,
  });
}

const went = (jobId: string) => store.runs(jobId)[0]!.steps?.map((step) => `${step.id}:${step.status}`);
const last = (jobId: string) => store.runs(jobId)[0]!;
/** What a command prints: a file's first line, so a test changes it between runs. */
const reads = (name: string) => `cat ${join(DIR, name)}`;
const write = async (name: string, text: string): Promise<void> => writeFileSync(join(DIR, name), text);

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  db = openDatabase(join(DIR, "t.db"));
  migrate(db);
  clock = NOON;
  hours = "";
  store = new CronStore({ db, config: CONFIG, timezone: "UTC", now: () => clock });
  watch = new WatchStore(db, () => clock);
});

afterEach(() => {
  db.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe("a step that goes on only when what it said has changed", () => {
  test("the first run goes on; the same words again end the run there, quietly; a change goes on", async () => {
    await write("disk", "disk at 91%");
    const made = job([sh("check", reads("disk"), { onlyChanged: true }), ask("tell", "Tell them.")]);
    const h = hands([{ text: "The disk is at 91%." }, { text: "The disk is at 95%." }]);

    const first = await h.due(made.id);
    expect(first).toMatchObject({ status: "success", result: "The disk is at 91%." });
    // What the scheduler kept of the run is its own: a caller is told how it went, not the hashes.
    expect(Object.keys(first).sort()).toEqual(["result", "status", "steps"]);
    expect(went(made.id)).toEqual(["check:done", "tell:done"]);

    // Nothing changed: no agent is woken and nothing is sent, and the run says why.
    expect(await h.due(made.id)).toMatchObject({ status: "success", result: 'step 1 of 2, the command `sh -c cat ' + join(DIR, "disk") + "` said the same as last time: the run ended there" });
    expect(went(made.id)).toEqual(["check:empty"]);
    expect(last(made.id).steps?.[0]?.said).toBe("said the same as last time");
    // Said as a field too: a page reads that, not the words.
    expect(last(made.id).steps?.[0]?.same).toBe(true);
    expect(h.turns).toHaveLength(1);
    expect(h.said()).toEqual(["The disk is at 91%."]);

    await write("disk", "disk at 95%");
    await h.due(made.id);
    expect(went(made.id)).toEqual(["check:done", "tell:done"]);
    expect(last(made.id).steps?.[0]).not.toHaveProperty("same");
    expect(h.said()).toEqual(["The disk is at 91%.", "The disk is at 95%."]);
    // And back to what it said two runs ago is a change too: only the last time is compared with.
    await write("disk", "disk at 91%");
    await h.due(made.id);
    expect(went(made.id)).toEqual(["check:done", "tell:done"]);
  });

  test("an unmarked step says the same thing every run", async () => {
    await write("disk", "disk at 91%");
    const made = job([sh("check", reads("disk")), ask("tell", "Tell them.")]);
    const h = hands();
    await h.due(made.id);
    await h.due(made.id);
    expect(h.turns).toHaveLength(2);
  });

  test("the same words take the step's own exit for nothing to say, where it names one", async () => {
    await write("disk", "disk at 91%");
    const made = job([sh("check", reads("disk"), { onlyChanged: true, whenEmpty: { to: "note" } }), ask("tell", "Tell them.", { then: "end" }), say("note", "Nothing new.")]);
    const h = hands();
    await h.due(made.id);
    await h.due(made.id);
    expect(went(made.id)).toEqual(["check:empty", "note:done"]);
    expect(h.said()).toEqual(["turn output", "Nothing new."]);
  });

  test("an agent's turn can be marked: its answer is what is compared", async () => {
    const made = job([ask("look", "How is the build?", { onlyChanged: true }), say("tell", "The build changed.")]);
    const h = hands([{ text: "red" }, { text: "red" }, { text: "green" }]);
    await h.due(made.id);
    await h.due(made.id);
    expect(went(made.id)).toEqual(["look:empty"]);
    expect(last(made.id).steps?.[0]?.same).toBe(true);
    await h.due(made.id);
    expect(went(made.id)).toEqual(["look:done", "tell:done"]);
    expect(h.said()).toEqual(["The build changed.", "The build changed."]);
  });

  test("a mission can be marked: what it ended with is compared, and it told its chat itself either way", async () => {
    const made = job([{ id: "audit", kind: "mission", goal: "Audit the backups.", onlyChanged: true }, say("tell", "The audit changed.")], { delivery: { mode: "announce", once: true } });
    const ends = new Map<string, MissionEnd>();
    let started = 0;
    const h = hands([], { startMission: () => ({ started: `msn_${(started += 1)}` }), missionEnd: (id) => ends.get(id) ?? { working: true } });
    const ended = async (said: string) => {
      await h.due(made.id);
      ends.set(`msn_${started}`, { said });
      h.scheduler.missionChanged(`msn_${started}`);
      await eventually(() => last(made.id).finishedAt !== undefined, 4_000, "the run to end");
    };

    await ended("All seven backups are whole.");
    expect(went(made.id)).toEqual(["audit:done", "tell:done"]);
    // A mission tells its chat how it ended, so a job that tells once has told: off after its first run.
    expect(store.get(made.id)).toMatchObject({ enabled: false, disabledReason: "told" });

    store.setEnabled(made.id, true, "tester");
    await ended("All seven backups are whole.");
    // The same again: the run ends there and the step after is not run.
    expect(went(made.id)).toEqual(["audit:empty"]);
    expect(last(made.id).steps?.[0]).toMatchObject({ said: "said the same as last time", same: true });
    expect(h.said()).toEqual(["The audit changed."]);
    // And it told its chat this time too, by itself: the mark decides what the run does next, not what a mission says.
    expect(store.get(made.id)).toMatchObject({ enabled: false, disabledReason: "told" });

    store.setEnabled(made.id, true, "tester");
    await ended("One backup is missing.");
    expect(went(made.id)).toEqual(["audit:done", "tell:done"]);
  });

  test("a failed step is not compared, and what it said before stands", async () => {
    await write("disk", "disk at 91%");
    const made = job([sh("check", `test -f ${join(DIR, "ok")} && ${reads("disk")}`, { onlyChanged: true, whenFailed: "end" }), ask("tell", "Tell them.")]);
    const h = hands();
    await write("ok", "");
    await h.due(made.id);
    rmSync(join(DIR, "ok"));
    expect((await h.due(made.id)).status).toBe("error");
    await write("ok", "");
    await h.due(made.id);
    // The same as before the failure: still nothing new.
    expect(went(made.id)).toEqual(["check:empty"]);
  });

  test("a run that failed before anybody heard keeps nothing: the next run says it", async () => {
    await write("disk", "disk at 91%");
    const made = job([sh("check", reads("disk"), { onlyChanged: true })]);
    let reachable = false;
    const h = hands(undefined, { deliver: async () => (reachable ? { ok: true } : { ok: false, reason: "the chat is gone" }) });
    expect((await h.due(made.id)).status).toBe("error");
    reachable = true;
    expect(await h.due(made.id)).toMatchObject({ status: "success", result: "disk at 91%" });
    expect(went(made.id)).toEqual(["check:done"]);
  });

  test("what is kept is a hash, never the words", async () => {
    await write("disk", "the secret word is kelapa");
    const made = job([sh("check", reads("disk"), { onlyChanged: true })]);
    await hands().due(made.id);
    const rows = db.prepare<{ job_id: string; step_id: string; hash: string }>("SELECT job_id, step_id, hash FROM cron_step_said").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: made.id, step_id: "check" });
    expect(rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain("kelapa");
    // Gone with its job.
    store.delete(made.id, "tester");
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM cron_step_said").get()!.n).toBe(0);
  });

  test("a run that waits carries what was said across the wait, and keeps it when a person says no", async () => {
    await write("disk", "disk at 91%");
    const made = job([sh("check", reads("disk"), { onlyChanged: true }), wait("ok", "Clean it up?"), say("done", "Cleaned.")]);
    const h = hands();
    expect((await h.due(made.id)).status).toBe("waiting");
    expect((store.waitingRuns()[0]!.state as RunState).said).toEqual({ check: expect.stringMatching(/^[0-9a-f]{64}$/) });
    h.scheduler.answerRun(last(made.id).id, false, "Gading", "dashboard");
    await eventually(() => last(made.id).status === "skipped", 4_000, "the run to end");
    // They were asked and said no: the same finding does not ask again.
    await h.due(made.id);
    expect(went(made.id)).toEqual(["check:empty"]);
    expect(h.asked).toHaveLength(1);
  });

  test("read from what a person or an agent wrote, and refused on a step with nothing of its own to say", () => {
    expect(stepsFrom([{ kind: "command", argv: ["true"], onlyChanged: true }, { kind: "agentTurn", message: "x", onlyChanged: "yes" }])).toMatchObject([{ onlyChanged: true }, expect.not.objectContaining({ onlyChanged: expect.anything() })]);
    expect(() => job([{ id: "a", kind: "systemEvent", text: "hello", onlyChanged: true }])).toThrow("step 1: only a command, an agent's turn or a mission can go on only when what it said has changed.");
    expect(() => job([sh("a", "true"), { id: "b", kind: "approval", ask: "ok?", onlyChanged: true }])).toThrow("step 2: only a command");
  });
});

describe("a webhook's body, handed to a command", () => {
  test("on its standard input: what it prints is what the agent's step is handed, with the word that it came from outside", async () => {
    const made = job([sh("pick", "sed -n 's/.*\"event\": *\"\\([a-z]*\\)\".*/a \\1 was seen/p'"), ask("tell", "Tell them what was seen.")]);
    const h = hands([{ text: "Somebody is at the door." }]);
    await h.due(made.id, '{"event": "person", "camera": "door", "token": "kelapa"}');

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.message).toContain("a person was seen");
    // The agent reads what the script printed, not what the caller sent.
    expect(h.turns[0]!.message).not.toContain("kelapa");
    expect(h.turns[0]!.message).not.toContain("camera");
    expect(h.turns[0]!.outsideContent).toEqual([WEBHOOK_PAYLOAD]);
    expect(h.said()).toEqual(["Somebody is at the door."]);
  });

  test("a script that prints nothing drops the call: no agent is woken and nothing is said", async () => {
    const made = job([sh("pick", "grep -q '\"event\": *\"person\"' && echo person || true"), ask("tell", "Tell them.")]);
    const h = hands();
    expect(await h.due(made.id, '{"event": "cat"}')).toMatchObject({ status: "success" });
    expect(went(made.id)).toEqual(["pick:empty"]);
    expect(h.turns).toEqual([]);
    expect(h.said()).toEqual([]);
  });

  test("never in its arguments or its environment", async () => {
    const made = job([sh("show", 'env; echo "args: $0 $*"')]);
    const h = hands();
    await h.due(made.id, "kelapa-in-the-body");
    expect(last(made.id).steps?.[0]?.said).toContain("args: sh");
    expect(JSON.stringify(last(made.id))).not.toContain("kelapa-in-the-body");
  });

  test("a command that is not the first to read it gets no input: the body is read once", async () => {
    const made = job([sh("first", "cat"), sh("second", "cat; echo second")]);
    const h = hands();
    await h.due(made.id, "the body");
    expect(last(made.id).steps?.map((step) => step.said)).toEqual(["the body", "second"]);
  });

  test("a run with no body gives a command nothing to read, and it does not wait for any", async () => {
    const made = job([sh("first", "cat; echo done")]);
    expect(await hands().due(made.id)).toMatchObject({ status: "success", result: "done" });
  });
});

describe("a job that turns itself off once it has told", () => {
  const once = { delivery: { mode: "announce" as const, once: true as const } };

  test("a run with nothing to say leaves it on; the first that tells turns it off, with why", async () => {
    await write("build", "");
    const made = job([sh("check", `${reads("build")}`), say("tell", "The build is done.")], once);
    const h = hands();
    await h.due(made.id);
    expect(store.get(made.id)).toMatchObject({ enabled: true });
    expect(h.said()).toEqual([]);

    await write("build", "done");
    await h.due(made.id);
    expect(h.said()).toEqual(["The build is done."]);
    expect(store.get(made.id)).toMatchObject({ enabled: false, disabledReason: TOLD });
    expect(store.get(made.id)?.nextRunAt).toBeUndefined();
  });

  test("a run whose last step's words are its own counts as telling", async () => {
    const made = job([sh("check", "echo 'the build is done'")], once);
    const h = hands();
    await h.due(made.id);
    expect(h.said()).toEqual(["the build is done"]);
    expect(store.get(made.id)).toMatchObject({ enabled: false, disabledReason: TOLD });
  });

  test("a job of one thing is held to it too, and one not marked stays on", async () => {
    const marked = job([], { payload: { kind: "systemEvent", text: "Time to stretch." }, trigger: { kind: "every", everyMs: 60_000 }, ...once });
    const plain = job([], { payload: { kind: "systemEvent", text: "Time to stretch." }, trigger: { kind: "every", everyMs: 60_000 } });
    const h = hands();
    await h.due(marked.id);
    await h.due(plain.id);
    expect(store.get(marked.id)).toMatchObject({ enabled: false, disabledReason: TOLD });
    expect(store.get(plain.id)).toMatchObject({ enabled: true });
  });

  test("a failed run leaves it on, and so does a run a person started by hand", async () => {
    const made = job([sh("check", "echo done"), say("tell", "The build is done.")], once);
    const h = hands(undefined, { deliver: async () => ({ ok: false, reason: "the chat is gone" }) });
    expect((await h.due(made.id)).status).toBe("error");
    expect(store.get(made.id)).toMatchObject({ enabled: true });

    const byHand = hands();
    expect((await byHand.scheduler.runNow(made.id, "tester")).status).toBe("success");
    expect(byHand.said()).toEqual(["The build is done."]);
    expect(store.get(made.id)).toMatchObject({ enabled: true });
  });

  test("turned on again, it tells once more and turns off again", async () => {
    const made = job([say("tell", "The build is done.")], once);
    const h = hands();
    await h.due(made.id);
    expect(store.setEnabled(made.id, true, "tester")).toMatchObject({ enabled: true });
    expect(store.get(made.id)?.disabledReason).toBeUndefined();
    await h.due(made.id);
    expect(h.said()).toEqual(["The build is done.", "The build is done."]);
    expect(store.get(made.id)).toMatchObject({ enabled: false, disabledReason: TOLD });
  });

  test("the two marks on where a job reports are read from what was sent, and only as `true`", () => {
    const sent = { agentId: "nouva", name: "x", manual: true, payload: { kind: "systemEvent", text: "x" }, target: { gatewayId: "telegram:main", chatId: "1" } };
    expect(cronInputFrom({ ...sent, delivery: { mode: "announce", once: true, atOnce: true } }, "tester", "UTC").delivery).toEqual({ mode: "announce", once: true, atOnce: true });
    expect(cronInputFrom({ ...sent, delivery: { mode: "announce", once: "yes", atOnce: 1 } }, "tester", "UTC").delivery).toEqual({ mode: "announce" });
  });

  test("a job that tells nobody cannot be marked", () => {
    expect(() => job([say("tell", "x")], { delivery: { mode: "none", once: true } })).toThrow("a job that tells nobody cannot turn itself off once it has told");
  });
});

describe("quiet hours", () => {
  test("the span, as it is written and as it is read", () => {
    expect(parseQuietHours("22:00-07:00")).toEqual({ from: 1320, to: 420 });
    expect(parseQuietHours(" 09:30-17:05 ")).toEqual({ from: 570, to: 1025 });
    for (const bad of ["", "22-07", "24:00-07:00", "22:60-07:00", "22:00", "22:00-22:00", "22:00 to 07:00"]) expect({ bad, span: parseQuietHours(bad) }).toEqual({ bad, span: null });
    expect(formatQuietHours({ from: 1320, to: 420 })).toBe("22:00-07:00");
    const night = { from: 1320, to: 420 };
    expect([1319, 1320, 0, 419, 420, 720].map((minute) => isQuiet(night, minute))).toEqual([false, true, true, true, false, false]);
    const day = { from: 540, to: 1020 };
    expect([539, 540, 1019, 1020].map((minute) => isQuiet(day, minute))).toEqual([false, true, true, false]);
    expect(minutesToQuietEnd(night, 190)).toBe(230);
    expect(minutesToQuietEnd(night, 1380)).toBe(480);
  });

  test("none set: everything is said as it is, whatever the hour", async () => {
    clock = NIGHT;
    const made = job([say("tell", "Disk at 91%.")]);
    const h = hands();
    await h.due(made.id);
    expect(h.said()).toEqual(["Disk at 91%."]);
    expect(watch.holding()).toBe(false);
  });

  test("inside them a run still runs, and what it would say is kept; outside them it is said at once", async () => {
    hours = "22:00-07:00";
    const made = job([sh("check", "echo 'disk at 91%'")]);
    const h = hands();
    await h.due(made.id);
    expect(h.said()).toEqual(["disk at 91%"]);

    clock = NIGHT;
    expect(await h.due(made.id)).toMatchObject({ status: "success", result: "disk at 91%" });
    expect(went(made.id)).toEqual(["check:done"]);
    expect(h.said()).toEqual(["disk at 91%"]);
    expect(watch.holding()).toBe(true);
  });

  test("what is kept now is said to a page: whose each thing is, and when the hours end", async () => {
    hours = "22:00-07:00";
    clock = NIGHT;
    const disk = job([sh("check", "echo 'disk at 91%'")]);
    const backup = job([sh("run", "echo 'no space left' >&2; exit 1")], { name: "backup" });
    const h = hands();
    // Nothing kept is nothing to say, in the night too.
    expect(h.scheduler.kept()).toBeNull();
    await h.due(disk.id);
    await h.due(backup.id);
    await h.due(disk.id);
    const kept = h.scheduler.kept()!;
    expect(kept.jobIds).toEqual([disk.id, backup.id, disk.id]);
    // Seven in the morning of the same night, in the daemon's zone.
    expect(new Date(kept.until).toISOString()).toBe(new Date(MORNING).toISOString());
  });

  test("when they end, what was kept is one message a chat: each automation by its name, failures first", async () => {
    hours = "22:00-07:00";
    clock = NIGHT;
    const disk = job([sh("check", "echo 'disk at 91%'")]);
    const backup = job([sh("run", "echo 'no space left' >&2; exit 1")], { name: "backup" });
    const elsewhere = job([say("tell", "The gate opened.")], { name: "gate", target: { gatewayId: "telegram:main", chatId: "999" } });
    const h = hands();
    await h.due(disk.id);
    clock += 60_000;
    expect((await h.due(backup.id)).status).toBe("error");
    clock += 60_000;
    await h.due(elsewhere.id);
    expect(h.said()).toEqual([]);

    // Still night: a tick says nothing of what is kept. That a tick ran is seen by a job marked to tell at once, due now.
    job([say("t", "tick")], { name: "marker", trigger: { kind: "every", everyMs: 60_000 }, delivery: { mode: "announce", atOnce: true }, target: { gatewayId: "telegram:main", chatId: "marker" } });
    clock += 61_000;
    h.scheduler.start();
    await eventually(() => h.said().includes("tick"), 4_000, "a tick in the night");
    expect(h.said()).toEqual(["tick"]);

    clock = MORNING;
    await eventually(() => h.delivered.filter((one) => one.target.chatId !== "marker").length === 2, 4_000, "the two chats to hear");
    await h.scheduler.stop();
    const own = h.delivered.find((one) => one.target.chatId === "12345")!.text;
    expect(own).toBe("Kept during the quiet hours (22:00 to 07:00):\n\n**backup** failed at 03:11\nstep 1 of 1, the command `sh -c echo 'no space left' >&2; exit 1` failed: exit 1\nno space left\n\n**disk watch** at 03:10\ndisk at 91%");
    expect(h.delivered.find((one) => one.target.chatId === "999")!.text).toBe("Kept during the quiet hours (22:00 to 07:00):\n\n**gate** at 03:12\nThe gate opened.");
    expect(watch.holding()).toBe(false);
  });

  test("a run a person started by hand is said at once: they are there", async () => {
    hours = "22:00-07:00";
    clock = NIGHT;
    const made = job([say("tell", "Disk at 91%.")]);
    const h = hands();
    await h.scheduler.runNow(made.id, "tester");
    expect(h.said()).toEqual(["Disk at 91%."]);
    expect(watch.holding()).toBe(false);
  });

  test("an automation marked to tell at once is said, and tells of its failure, whatever the hour", async () => {
    hours = "22:00-07:00";
    clock = NIGHT;
    const camera = job([say("tell", "Somebody is at the door.")], { name: "camera", delivery: { mode: "announce", atOnce: true } });
    const broken = job([sh("run", "exit 3")], { name: "alarm", delivery: { mode: "announce", atOnce: true } });
    const h = hands();
    await h.due(camera.id);
    await h.due(broken.id);
    expect(h.said()).toEqual(["Somebody is at the door.", "Scheduled job **alarm** failed.\nstep 1 of 1, the command `sh -c exit 3` failed: exit 3"]);
    expect(watch.holding()).toBe(false);
  });

  test("what goes to a URL or to nowhere wakes nobody, and is not kept", async () => {
    hours = "22:00-07:00";
    clock = NIGHT;
    const posted: unknown[] = [];
    const hook = job([say("tell", "x")], { name: "to a url", payload: { kind: "command", argv: ["sh", "-c", "echo out"], then: "deliver" }, delivery: { mode: "webhook", webhookUrl: "https://example.test/hook" } });
    const h = hands(undefined, { webhook: async (_url, body) => void posted.push(body) });
    await h.due(hook.id);
    expect(posted).toHaveLength(1);
    expect(watch.holding()).toBe(false);
  });

  test("a turn that would be put into the chat is run apart instead, and its words kept", async () => {
    hours = "22:00-07:00";
    clock = NIGHT;
    const made = job([], { payload: { kind: "agentTurn", message: "Anything new?" }, session: "chat", trigger: { kind: "every", everyMs: 60_000 } });
    const h = hands([{ text: "Two new mails." }]);
    await h.due(made.id);
    expect(h.dispatched).toEqual([]);
    expect(h.turns).toHaveLength(1);
    expect(h.said()).toEqual([]);
    expect(watch.release().map((line) => [line.kind, line.text])).toEqual([["said", "Two new mails."]]);
  });

  test("a question is kept too: asked when the hours end, with its time to answer counted from then", async () => {
    hours = "22:00-07:00";
    clock = NIGHT;
    const made = job([sh("check", "echo 'the shop is down'"), wait("ok", "Restart it?"), say("done", "Restarted.")]);
    const h = hands();
    expect((await h.due(made.id)).status).toBe("waiting");
    expect(h.asked).toEqual([]);
    // The dashboard lists it meanwhile, and its time runs from the morning.
    const waiting = store.waitingRuns()[0]!;
    expect(waiting.state.wait).toMatchObject({ kind: "approval", since: MORNING, until: MORNING + APPROVAL_WAIT_MS });
    expect(waiting.state.card).toBeUndefined();

    clock = MORNING;
    h.scheduler.start();
    await eventually(() => h.asked.length === 1, 4_000, "the question to be asked");
    await h.scheduler.stop();
    expect(h.asked[0]).toMatchObject({ runId: waiting.run.id, question: "Restart it?", shown: "the shop is down", until: MORNING + APPROVAL_WAIT_MS });
    // Its card is kept with the run, to rewrite once it is answered.
    expect(store.waitingRuns()[0]!.state.card).toEqual({ gatewayId: "telegram:main", chatId: "12345", messageId: "card1" });
    // A question is not part of the morning's message.
    expect(h.said()).toEqual([]);
  });

  test("a question answered from the dashboard in the night is not asked in the morning", async () => {
    hours = "22:00-07:00";
    clock = NIGHT;
    const made = job([sh("check", "echo 'the shop is down'"), wait("ok", "Restart it?"), say("done", "Restarted.")], { delivery: { mode: "announce" } });
    const h = hands();
    await h.due(made.id);
    h.scheduler.answerRun(last(made.id).id, true, "Gading", "dashboard");
    await eventually(() => last(made.id).status === "success", 4_000, "the run to end");
    clock = MORNING;
    h.scheduler.start();
    await eventually(() => !watch.holding(), 4_000, "the kept lines to be said");
    await h.scheduler.stop();
    expect(h.asked).toEqual([]);
    // What the run said after the yes, still in the night, was kept and is in the morning's message.
    expect(h.said()).toEqual(["Kept during the quiet hours (22:00 to 07:00):\n\n**disk watch** at 03:10\nRestarted."]);
  });

  test("a job set to tell once turns off when its words are kept: the morning hears it once", async () => {
    hours = "22:00-07:00";
    clock = NIGHT;
    const made = job([say("tell", "The build is done.")], { delivery: { mode: "announce", once: true } });
    const h = hands();
    await h.due(made.id);
    expect(store.get(made.id)).toMatchObject({ enabled: false, disabledReason: TOLD });
    expect(watch.release().map((line) => line.text)).toEqual(["The build is done."]);
  });

  test("a job deleted in the night takes what it said with it", async () => {
    hours = "22:00-07:00";
    clock = NIGHT;
    const made = job([say("tell", "x")]);
    const h = hands();
    await h.due(made.id);
    store.delete(made.id, "tester");
    expect(watch.holding()).toBe(false);
  });

  test("a crowded morning cuts each automation's words, and says it cut them", async () => {
    hours = "22:00-07:00";
    clock = NIGHT;
    const h = hands();
    for (let n = 0; n < 6; n += 1) {
      const one = job([sh("check", `printf '%0.sa' $(seq 1 1500)`)], { name: `watch ${n}` });
      await h.due(one.id);
    }
    clock = MORNING;
    h.scheduler.start();
    await eventually(() => h.delivered.length === 1, 4_000, "the morning's message");
    await h.scheduler.stop();
    const text = h.said()[0]!;
    expect(text.length).toBeLessThan(4000);
    expect(text.match(/…\(cut\)/g)).toHaveLength(6);
    for (let n = 0; n < 6; n += 1) expect(text).toContain(`**watch ${n}** at 03:10`);
  });
});
