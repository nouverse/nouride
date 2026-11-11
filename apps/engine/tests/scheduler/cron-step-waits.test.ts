/**
 * A run of several steps that stops to wait (`step-runs.ts`): for a mission, however long it takes, and for a person's
 * answer. Each case is a way the wait must not go wrong: the run counted as over while it waits, a second run started
 * beside it, the wait lost in a restart, the mission's failure read as its result, a person's no reported as the job
 * failing, an answer taken twice or from someone who may not give it, or a run left waiting for good.
 *
 * The executors are doubles and the store is real, on a database of its own: what a waiting run needs is only ever in
 * its row, which is what a second scheduler on the same store, a restart, reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { ButtonPress, CronSection, Job, JobStep, JobTarget, MessageButton } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { CronStore, type JobInput, type RunState } from "@/modules/cron/cron.store.ts";
import { CronScheduler, type CronExecutors, type JobTurnRequest } from "@/modules/cron/scheduler.ts";
import { StepAsks, askCard } from "@/modules/cron/step-asks.ts";
import type { MissionEnd } from "@/modules/missions/job-runs.ts";
import { APPROVAL_WAIT_MS } from "@/modules/cron/steps.ts";
import { eventually } from "../helpers.ts";

const CONFIG: CronSection = {
  enabled: true,
  minIntervalMs: 1000,
  maxJobs: 20,
  runRetentionDays: 14,
  catchupWindowMs: 60_000,
  failStreakLimit: 3,
  unattendedApproval: "auto",
  commandTimeoutMs: 5000,
};

const START = Date.parse("2026-08-18T10:00:00Z");
let dir: string;
let db: SqliteDb;
let store: CronStore;
let clock: number;

type Exits = Pick<JobStep, "then" | "whenFailed" | "whenEmpty">;
const ask = (id: string, message: string, more: Exits & { agentId?: string } = {}): JobStep => ({ id, kind: "agentTurn", message, ...more });
const say = (id: string, text: string, exits: Exits = {}): JobStep => ({ id, kind: "systemEvent", text, ...exits });
const mission = (id: string, goal: string, exits: Exits = {}): JobStep => ({ id, kind: "mission", goal, ...exits });
const wait = (id: string, question: string, more: Exits & { timeoutMs?: number } = {}): JobStep => ({ id, kind: "approval", ask: question, ...more });

/** The daemon's hands, recorded, with the missions a test says have ended and the cards a step asked on. */
function hands(overrides: Partial<CronExecutors> = {}, maxSleepMs = 5) {
  const delivered: { target: JobTarget; text: string }[] = [];
  const turns: JobTurnRequest[] = [];
  const started: { job: Job; body: string | undefined }[] = [];
  const asked: { runId: string; question: string; shown: string; until: number }[] = [];
  const settled: { card: NonNullable<RunState["card"]>; text: string }[] = [];
  const ended = new Map<string, MissionEnd>();
  const executors: CronExecutors = {
    runTurn: async (request) => {
      turns.push(request);
      return { text: `${request.job.agentId} answered` };
    },
    dispatchTurn: () => true,
    deliver: async (target, text) => {
      delivered.push({ target, text });
      return { ok: true };
    },
    commandSandbox: () => ({ cwd: dir, env: {} }),
    startMission: (job, body) => {
      started.push({ job, body });
      return { started: `msn_${started.length}` };
    },
    missionEnd: (id) => ended.get(id) ?? (started.some((_, n) => `msn_${n + 1}` === id) ? { working: true } : null),
    ask: async (_job, runId, step, shown, until) => {
      asked.push({ runId, question: step.ask, shown, until });
      return { gatewayId: "telegram:main", chatId: "12345", messageId: `card${asked.length}` };
    },
    settleAsk: (card, text) => void settled.push({ card, text }),
    ...overrides,
  };
  const scheduler = new CronScheduler({ store, config: CONFIG, executors, now: () => clock, maxSleepMs });
  /** A mission's end, as the missions tell the scheduler. */
  const finish = (id: string, end: Exclude<MissionEnd, { working: true }>) => {
    ended.set(id, end);
    scheduler.missionChanged(id);
  };
  return { scheduler, delivered, turns, started, asked, settled, ended, finish };
}

function job(steps: JobStep[], overrides: Partial<JobInput> = {}): Job {
  return store.create({
    agentId: "nouva",
    name: "weekly",
    trigger: { kind: "manual" },
    payload: { kind: "steps", steps },
    target: { gatewayId: "telegram:main", chatId: "12345" },
    createdBy: "8142",
    ...overrides,
  });
}

const run = (jobId: string) => store.runs(jobId)[0]!;
const went = (jobId: string) => run(jobId).steps?.map((step) => `${step.id}:${step.status}`);
const over = (jobId: string) => eventually(() => run(jobId).finishedAt !== undefined, 4_000, "the run to end");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-tmp-step-waits-"));
  db = openDatabase(join(dir, "t.db"));
  migrate(db);
  clock = START;
  store = new CronStore({ db, config: CONFIG, timezone: "UTC", now: () => clock });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a mission as a step", () => {
  test("in the middle: the run waits for it, is not over, and goes on with its result when it ends", async () => {
    const made = job([ask("collect", "Collect the issues."), mission("fix", "Fix them."), ask("report", "Write what was done.", { agentId: "nix" })]);
    const h = hands();

    const outcome = await h.scheduler.runNow(made.id, "tester");

    expect(outcome).toEqual({ status: "waiting", result: "waiting at step 2 of 3, the mission: mission msn_1 is at work" });
    // The mission was handed what the step before said, and runs as that step: its goal, the job's agent and chat.
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.body).toBe("nouva answered");
    expect(h.started[0]!.job.payload).toMatchObject({ kind: "mission", goal: "Fix them." });
    // Not over: no end time, the step marked as waiting with its mission, and nothing counted for the job yet.
    expect(run(made.id)).toMatchObject({ status: "waiting", waiting: { kind: "mission", step: "fix", missionId: "msn_1" } });
    expect(run(made.id).finishedAt).toBeUndefined();
    expect(went(made.id)).toEqual(["collect:done", "fix:waiting"]);
    expect(run(made.id).steps![1]!.missionId).toBe("msn_1");
    expect(store.get(made.id)!.runCount).toBe(0);
    expect(h.turns).toHaveLength(1);

    h.finish("msn_1", { said: "Two issues fixed, one left open." });
    await over(made.id);

    expect(h.turns).toHaveLength(2);
    expect(h.turns[1]!.job.agentId).toBe("nix");
    expect(h.turns[1]!.message).toContain("The mission ran before this step and said what is below.");
    expect(h.turns[1]!.message).toContain("Two issues fixed, one left open.");
    expect(run(made.id)).toMatchObject({ status: "success", result: "nix answered" });
    expect(went(made.id)).toEqual(["collect:done", "fix:done", "report:done"]);
    expect(h.delivered.map((d) => d.text)).toEqual(["nix answered"]);
    expect(store.get(made.id)!.runCount).toBe(1);
  });

  test("first, with a webhook's body as its request; and last, where its own word to the chat is the run's", async () => {
    const made = job([mission("build", "Build what was asked.")], { trigger: { kind: "webhook" } });
    const h = hands();
    await h.scheduler.runNow(made.id, "webhook", { body: "build the site" });
    expect(h.started[0]!.body).toBe("build the site");

    h.finish("msn_1", { said: "The site is built." });
    await over(made.id);
    expect(run(made.id)).toMatchObject({ status: "success", result: "The site is built." });
    // A mission tells its chat how it ended: the run does not say it a second time.
    expect(h.delivered).toEqual([]);
  });

  test("handed a webhook's body and an earlier step's words, each is named: the mission can tell them apart", async () => {
    const made = job([{ id: "note", kind: "command", argv: ["sh", "-c", "printf 'disk 91%%'"] }, mission("fix", "Free some space.")], { trigger: { kind: "webhook" } });
    const h = hands();
    await h.scheduler.runNow(made.id, "webhook", { body: "alert from the monitor" });
    expect(h.started[0]!.body).toBe("The webhook's payload:\nalert from the monitor\n\nWhat the step before said:\ndisk 91%");
  });

  test("another agent's mission is started as that agent's", async () => {
    const made = job([{ id: "m", kind: "mission", goal: "Review it.", agentId: "nix" }]);
    const h = hands();
    await h.scheduler.runNow(made.id, "tester");
    expect(h.started[0]!.job.agentId).toBe("nix");
  });

  test("one that failed or was stopped is a failed step: the run ends failed, or goes where the step says", async () => {
    const plain = job([mission("fix", "Fix it."), say("after", "never")]);
    const h = hands();
    await h.scheduler.runNow(plain.id, "tester");
    h.finish("msn_1", { failed: "the mission failed: gave up after three tries" });
    await over(plain.id);
    expect(run(plain.id)).toMatchObject({ status: "error", result: "step 1 of 2, the mission failed: the mission failed: gave up after three tries" });
    expect(went(plain.id)).toEqual(["fix:failed"]);
    expect(h.delivered.map((d) => d.text).join("\n")).toContain("Scheduled job **weekly** failed.");

    const branched = job([mission("fix", "Fix it.", { whenFailed: { to: "tell" } }), say("done", "Fixed.", { then: "end" }), ask("tell", "Say what went wrong.")], { name: "branched" });
    const b = hands();
    await b.scheduler.runNow(branched.id, "tester");
    b.finish("msn_1", { failed: "the mission was stopped" });
    await over(branched.id);
    expect(went(branched.id)).toEqual(["fix:failed", "tell:done"]);
    expect(b.turns[0]!.message).toContain("ran before this step and failed.");
    expect(b.turns[0]!.message).toContain("the mission was stopped");
    expect(run(branched.id).status).toBe("success");
  });

  test("a mission that only changed, and is still at work, wakes nothing", async () => {
    const made = job([mission("fix", "Fix it.")]);
    const h = hands();
    await h.scheduler.runNow(made.id, "tester");
    h.scheduler.missionChanged("msn_1");
    h.scheduler.missionChanged("msn_other");
    // Still as it was: said from the row, which a wake would have changed at once.
    expect(run(made.id).status).toBe("waiting");
    expect(went(made.id)).toEqual(["fix:waiting"]);
  });

  test("a run of the job due while one waits is not started beside it, by hand or by the clock", async () => {
    const made = job([mission("fix", "Fix it.")], { trigger: { kind: "every", everyMs: 60_000 } });
    const h = hands();
    h.scheduler.start();
    clock += 61_000;
    await eventually(() => store.runs(made.id).length === 1 && run(made.id).status === "waiting", 4_000, "the scheduled run to wait");
    // Claimed by its run and not given back yet: the job is not due again while that run waits.
    expect(store.get(made.id)!.nextRunAt).toBeUndefined();
    clock += 600_000;
    expect(await h.scheduler.runNow(made.id, "tester")).toEqual({ status: "unavailable", result: "its last run is still waiting for mission msn_1" });
    expect(h.scheduler.isRunning(made.id)).toBe(true);

    h.finish("msn_1", { said: "Done." });
    await over(made.id);
    // Over: counted once, and due again a whole interval from when it ended.
    expect(store.runs(made.id)).toHaveLength(1);
    expect(store.get(made.id)).toMatchObject({ runCount: 1, nextRunAt: clock + 60_000 });
    await h.scheduler.stop();
  });

  test("a run forced by hand that waits takes its job's time, and gives it back uncounted when it ends", async () => {
    const made = job([mission("fix", "Fix it.")], { trigger: { kind: "every", everyMs: 60_000 } });
    const h = hands();
    expect(store.get(made.id)!.nextRunAt).toBe(START + 60_000);
    await h.scheduler.runNow(made.id, "tester");
    expect(store.get(made.id)!.nextRunAt).toBeUndefined();

    clock += 5 * 60_000;
    h.finish("msn_1", { said: "Done." });
    await over(made.id);
    // A forced run settles nothing for its job: no count, and its next time is from now.
    expect(store.get(made.id)).toMatchObject({ runCount: 0, nextRunAt: clock + 60_000 });
  });

  test("a mission still working from the job's last run skips this one, as a job of one mission does", async () => {
    const made = job([mission("fix", "Fix it.")]);
    const h = hands({ startMission: () => ({ busy: "msn_9" }) });
    expect(await h.scheduler.runNow(made.id, "tester")).toMatchObject({ status: "skipped", result: "the last run, mission msn_9, is still working" });
  });
});

describe("a restart while a run waits", () => {
  test("the wait is in the run's row: a new scheduler leaves it waiting, and goes on when the mission ends", async () => {
    const made = job([mission("fix", "Fix it."), ask("report", "Report.")], { trigger: { kind: "every", everyMs: 60_000 } });
    const before = hands();
    before.scheduler.start();
    clock += 61_000;
    await eventually(() => store.runs(made.id).length === 1 && run(made.id).status === "waiting", 4_000, "the run to wait");
    await before.scheduler.stop();

    // The daemon restarted: nothing of the first scheduler is left, and the mission is still at work.
    const stands: { end: MissionEnd } = { end: { working: true } };
    const after = hands({ missionEnd: () => stands.end });
    after.scheduler.start();
    // A waiting run was not cut off by the restart, and its job was not given a time as if it had been.
    expect(run(made.id).status).toBe("waiting");
    expect(store.get(made.id)!.nextRunAt).toBeUndefined();

    stands.end = { said: "Fixed." };
    after.scheduler.missionChanged("msn_1");
    await over(made.id);
    expect(run(made.id)).toMatchObject({ status: "success", result: "nouva answered" });
    expect(after.turns[0]!.message).toContain("Fixed.");
    await after.scheduler.stop();
  });

  test("a mission that ended while the daemon was down is found at boot, and one that is gone is a failed step", async () => {
    const ended = job([mission("fix", "Fix it.")]);
    const gone = job([mission("fix", "Fix it.")], { name: "gone" });
    const before = hands();
    await before.scheduler.runNow(ended.id, "tester");
    await before.scheduler.runNow(gone.id, "tester");

    const after = hands({ missionEnd: (id) => (id === "msn_1" ? { said: "Fixed overnight." } : null) });
    after.scheduler.start();
    await over(ended.id);
    await over(gone.id);
    expect(run(ended.id)).toMatchObject({ status: "success", result: "Fixed overnight." });
    expect(run(gone.id)).toMatchObject({ status: "error", result: "step 1 of 1, the mission failed: its mission is gone" });
    await after.scheduler.stop();
  });

  test("a run at work when the process went is interrupted; one that waited is neither that nor swept as history", async () => {
    const made = job([mission("fix", "Fix it.")]);
    const h = hands();
    await h.scheduler.runNow(made.id, "tester");
    const working = store.startRun(made.id);

    expect(store.reconcileInterrupted()).toBe(1);
    expect(store.runs(made.id).find((one) => one.id === working.id)!.status).toBe("interrupted");
    expect(store.waitingRuns().map((one) => one.run.jobId)).toEqual([made.id]);

    clock += 30 * 86_400_000;
    store.sweepRuns();
    expect(store.waitingRuns()).toHaveLength(1);
    expect(store.runs(made.id).map((one) => one.status)).toEqual(["waiting"]);
  });

  test("a job removed takes its waiting run with it; one changed under a waiting run ends that run and nothing else", async () => {
    const removed = job([mission("fix", "Fix it."), say("after", "never")]);
    const shorter = job([mission("fix", "Fix it."), say("after", "never")], { name: "shorter" });
    const single = job([mission("fix", "Fix it."), say("after", "never")], { name: "single" });
    const h = hands();
    await h.scheduler.runNow(removed.id, "tester");
    await h.scheduler.runNow(shorter.id, "tester");
    await h.scheduler.runNow(single.id, "tester");
    store.delete(removed.id, "tester");
    store.update(shorter.id, { payload: { kind: "steps", steps: [say("after", "still here")] } }, "tester");
    store.update(single.id, { payload: { kind: "systemEvent", text: "one thing now" } }, "tester");
    // Deleting a job is a decision about the whole of it: its history goes, the run that waited too.
    expect(store.waitingRuns().map((one) => one.run.jobId).sort()).toEqual([shorter.id, single.id].sort());

    h.finish("msn_1", { said: "Done." });
    h.finish("msn_2", { said: "Done." });
    h.finish("msn_3", { said: "Done." });
    await over(shorter.id);
    await over(single.id);
    expect(run(shorter.id)).toMatchObject({ status: "interrupted", result: "the step it waited in is no longer in the list: the run ended there" });
    expect(run(single.id)).toMatchObject({ status: "interrupted", result: "its job was removed or changed into one thing while the run waited" });
    expect(h.delivered).toEqual([]);
  });
});

describe("a step that waits for a person", () => {
  test("asks once with what the step before said, waits, and a yes hands that on to the next step", async () => {
    const made = job([ask("draft", "Draft the reply."), wait("ok", "Send this reply?"), ask("send", "Send it.", { agentId: "nix" })]);
    const h = hands();

    const outcome = await h.scheduler.runNow(made.id, "tester");

    expect(outcome).toEqual({ status: "waiting", result: "waiting at step 2 of 3, the wait for a person: for a person's answer" });
    expect(h.asked).toEqual([{ runId: run(made.id).id, question: "Send this reply?", shown: "nouva answered", until: START + APPROVAL_WAIT_MS }]);
    expect(run(made.id).waiting).toEqual({ kind: "approval", step: "ok", since: START, until: START + APPROVAL_WAIT_MS, ask: "Send this reply?" });
    expect(went(made.id)).toEqual(["draft:done", "ok:waiting"]);
    // No model is asked while it waits.
    expect(h.turns).toHaveLength(1);

    expect(h.scheduler.answerRun(run(made.id).id, true, "Gading", "dashboard")).toMatchObject({ ok: true });
    await over(made.id);

    expect(h.turns).toHaveLength(2);
    expect(h.turns[1]!.message).toContain("nouva ran before this step and said what is below.");
    expect(went(made.id)).toEqual(["draft:done", "ok:done", "send:done"]);
    expect(run(made.id).steps![1]).toMatchObject({ by: "Gading", said: "Gading said yes" });
    expect(run(made.id).status).toBe("success");
    // Answered on the dashboard: the card in the chat follows, and loses its buttons.
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]!.card.messageId).toBe("card1");
    expect(h.settled[0]!.text).toBe("**weekly**: Send this reply?\n\n✅ Gading said to continue.");
  });

  test("a no ends the run there, as a person's choice and not the job's failure; or goes where the step says", async () => {
    const plain = job([wait("ok", "Deploy?"), say("deploy", "Deploying.")]);
    const h = hands();
    await h.scheduler.runNow(plain.id, "tester");
    h.scheduler.answerRun(run(plain.id).id, false, "Gading", "dashboard");
    await over(plain.id);
    expect(run(plain.id)).toMatchObject({ status: "skipped", result: "step 1 of 2, the wait for a person: Gading said no" });
    expect(went(plain.id)).toEqual(["ok:declined"]);
    // Nothing is deployed, and nobody is sent a failure report.
    expect(h.delivered).toEqual([]);
    expect(h.settled[0]!.text).toContain("🛑 Stopped by Gading.");

    const branched = job([wait("ok", "Deploy?", { whenFailed: { to: "cancelled" } }), say("deploy", "Deploying.", { then: "end" }), say("cancelled", "Deploy cancelled.")], { name: "branched" });
    const b = hands();
    await b.scheduler.runNow(branched.id, "tester");
    b.scheduler.answerRun(run(branched.id).id, false, "Gading", "dashboard");
    await over(branched.id);
    expect(went(branched.id)).toEqual(["ok:declined", "cancelled:done"]);
    expect(b.delivered.map((d) => d.text)).toEqual(["Deploy cancelled."]);
  });

  test("an answer is taken once, and only while it waits", async () => {
    const made = job([wait("ok", "Go?")]);
    const h = hands();
    await h.scheduler.runNow(made.id, "tester");
    const id = run(made.id).id;
    expect(h.scheduler.answerRun(id, true, "Gading", "dashboard")).toMatchObject({ ok: true });
    await over(made.id);
    expect(h.scheduler.answerRun(id, false, "Rina", "dashboard")).toEqual({ refused: "That is not waiting any more.", settled: "⌛ No longer waiting." });
    expect(h.scheduler.answerRun("run_missing", true, "Gading", "dashboard")).toMatchObject({ refused: "That is not waiting any more." });
    expect(run(made.id).steps![0]).toMatchObject({ status: "done", by: "Gading" });
  });

  test("with no answer in its time the run ends there, and the card says so: on the scheduler's own timer", async () => {
    const made = job([wait("ok", "Go?", { timeoutMs: 600_000 }), say("after", "never")]);
    const h = hands();
    await h.scheduler.runNow(made.id, "tester");
    h.scheduler.start();
    clock += 599_000;
    expect(run(made.id).status).toBe("waiting");

    clock += 2_000;
    await over(made.id);
    expect(run(made.id)).toMatchObject({ status: "skipped", result: "step 1 of 2, the wait for a person: nobody answered in time" });
    expect(went(made.id)).toEqual(["ok:expired"]);
    expect(h.settled[0]!.text).toBe("**weekly**: Go?\n\n⌛ Nobody answered in time, so it stopped there.");
    expect(h.delivered).toEqual([]);
    await h.scheduler.stop();
  });

  test("the timer is set for the step's own deadline, not left to the next time a job is due", async () => {
    const made = job([wait("ok", "Go?", { timeoutMs: 600_000 })]);
    const before = hands();
    await before.scheduler.runNow(made.id, "tester");

    // Nothing is due and the timer would sleep a minute: only the waiting step's deadline, already past, wakes it sooner.
    clock += 601_000;
    const after = hands({}, 60_000);
    after.scheduler.start();
    await over(made.id);
    expect(run(made.id).status).toBe("skipped");
    await after.scheduler.stop();
  });

  test("a run that waits for a mission takes no person's answer", async () => {
    const made = job([mission("fix", "Fix it.")]);
    const h = hands();
    await h.scheduler.runNow(made.id, "tester");
    expect(h.scheduler.answerRun(run(made.id).id, true, "Gading", "dashboard")).toEqual({ refused: "That is not waiting any more.", settled: "⌛ No longer waiting." });
    // Still waiting for its mission: said from its row, which an answer taken would have changed at once.
    expect(run(made.id)).toMatchObject({ status: "waiting", waiting: { kind: "mission" } });
    expect(h.settled).toEqual([]);
  });

  test("it waits across a restart: answered after one, the run goes on", async () => {
    const made = job([wait("ok", "Go?"), ask("go", "Go.")]);
    const before = hands();
    await before.scheduler.runNow(made.id, "tester");

    const after = hands();
    after.scheduler.start();
    expect(run(made.id).status).toBe("waiting");
    after.scheduler.answerRun(run(made.id).id, true, "Gading", "dashboard");
    await over(made.id);
    expect(after.turns).toHaveLength(1);
    expect(run(made.id).status).toBe("success");
    await after.scheduler.stop();
  });
});

describe("the question in the chat", () => {
  const ADMINS = new Set(["admin"]);

  function chat(answer = (_runId: string, _go: boolean, _by: string) => ({ ok: true as const, settled: "settled words" })) {
    const posted: { target: { gatewayId: string; chatId: string }; text: string; buttons: MessageButton[] }[] = [];
    const answers: { runId: string; go: boolean; by: string }[] = [];
    const asks = new StepAsks({
      store,
      notifier: {
        ask: async (target, text, buttons) => (posted.push({ target, text: text(true), buttons }), { ids: [`m${posted.length}`], buttons: true }),
        settle: async () => true,
      },
      voice: (agentId, gatewayId) => (agentId === "nouva" ? "telegram:nouva" : gatewayId),
      isAdmin: (who) => ADMINS.has(who.senderId),
      answer: (runId, go, by) => (answers.push({ runId, go, by }), answer(runId, go, by)),
      when: (at) => new Date(at).toISOString().slice(0, 16).replace("T", " "),
    });
    return { asks, posted, answers };
  }

  /** A run waiting for a person, asked through the real card, in a chat of this kind. */
  async function waiting(c: ReturnType<typeof chat>, overrides: Partial<JobInput> = {}) {
    const made = job([wait("ok", "Deploy to production?")], overrides);
    const h = hands({ ask: (asked, runId, step, shown, until) => c.asks.ask(asked, runId, step, shown, until) });
    await h.scheduler.runNow(made.id, "tester");
    return { made, runId: run(made.id).id };
  }
  const press = (runId: string, how: "go" | "no", who: Partial<ButtonPress> = {}): ButtonPress => ({
    gatewayId: "telegram:nouva",
    chatId: "12345",
    chatType: "dm",
    messageId: "m1",
    data: `run:${how}:${runId}`,
    senderId: "8142",
    senderName: "Gading",
    ...who,
  });

  test("the card goes where the job reports, in its agent's voice, with Continue and Stop that name the run", async () => {
    const c = chat();
    const { runId } = await waiting(c);

    expect(c.posted).toHaveLength(1);
    expect(c.posted[0]!.target).toEqual({ gatewayId: "telegram:nouva", chatId: "12345" });
    expect(c.posted[0]!.text).toBe("⏸ **weekly** waits for you: Deploy to production?\n\nWith no answer by 2026-08-19 10:00, it stops there.");
    expect(c.posted[0]!.buttons).toEqual([
      { label: "Continue", data: `run:go:${runId}`, style: "positive" },
      { label: "Stop", data: `run:no:${runId}`, style: "negative" },
    ]);
    expect(new TextEncoder().encode(`run:go:${runId}`).length).toBeLessThanOrEqual(64);
    // The card is kept on the run, so it can be rewritten after a restart.
    expect(store.waitingRun(runId)!.state.card).toEqual({ gatewayId: "telegram:nouva", chatId: "12345", messageId: "m1" });
    expect(c.asks.owns(`run:go:${runId}`)).toBe(true);
    expect(c.asks.owns("job:on:cron_x")).toBe(false);
  });

  test("the card shows what the step before said, cut to a glance, and says where to answer where there are no buttons", () => {
    expect(askCard({ name: "weekly" }, "Send?", "The draft.", "tomorrow", true)).toBe("⏸ **weekly** waits for you: Send?\n\nThe draft.\n\nWith no answer by tomorrow, it stops there.");
    expect(askCard({ name: "weekly" }, "Send?", "", "tomorrow", false)).toBe("⏸ **weekly** waits for you: Send?\n\nAnswer it on the dashboard, under Waiting for you. With no answer by tomorrow, it stops there.");
    const long = askCard({ name: "weekly" }, "Send?", "x".repeat(5000), "tomorrow", true);
    expect(long.length).toBeLessThan(1400);
    expect(long).toContain("…");
  });

  test("a press is the answer, from the person in a one-to-one chat", async () => {
    const c = chat();
    const { runId } = await waiting(c);
    expect(await c.asks.press(press(runId, "go"))).toEqual({ notice: "Carrying on.", settled: "settled words" });
    expect(await c.asks.press(press(runId, "no"))).toEqual({ notice: "Stopped.", settled: "settled words" });
    expect(c.answers).toEqual([{ runId, go: true, by: "Gading" }, { runId, go: false, by: "Gading" }]);
  });

  test("in a room only whoever turned the job on, or an admin, may answer; and only where it was asked", async () => {
    const c = chat();
    const { runId } = await waiting(c);
    const room = { chatType: "group" as const };

    expect(await c.asks.press(press(runId, "go", { ...room, senderId: "someone", senderName: "Someone" }))).toEqual({ notice: "Only whoever turned this on, or an admin, can answer it." });
    expect(await c.asks.press(press(runId, "go", { chatId: "other" }))).toEqual({ notice: "That was not asked here." });
    expect(c.answers).toEqual([]);

    expect((await c.asks.press(press(runId, "go", { ...room, senderId: "8142" }))).notice).toBe("Carrying on.");
    expect((await c.asks.press(press(runId, "go", { ...room, senderId: "admin", senderName: "Admin" }))).notice).toBe("Carrying on.");
    expect(c.answers.map((one) => one.by)).toEqual(["Gading", "Admin"]);
  });

  test("a press on a card whose run no longer waits says so and takes the buttons away", async () => {
    const c = chat();
    expect(await c.asks.press(press("run_gone", "go"))).toEqual({ notice: "That is not waiting any more.", settled: "⌛ No longer waiting." });
    expect(await c.asks.press(press("nonsense", "go", { data: "run:maybe:x" }))).toEqual({ notice: "That button is not one I know any more." });
    expect(c.answers).toEqual([]);
  });

  test("a job that reports nowhere asks on the dashboard alone", async () => {
    const c = chat();
    const { runId } = await waiting(c, { delivery: { mode: "none" } });
    expect(c.posted).toEqual([]);
    expect(store.waitingRun(runId)!.state.card).toBeUndefined();
    expect(store.waitingRun(runId)!.state.wait.kind).toBe("approval");
  });
});
