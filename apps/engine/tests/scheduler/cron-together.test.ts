/**
 * Steps at the same time (`kind: "parallel"`): agents' turns and commands begun together in one step of a job, which
 * ends when the last of them has, their words joined, each under its name, and handed on as what the step said. One
 * that failed is the step's failed exit with what the others said kept; all with nothing to say is its empty exit.
 * The executors are doubles, as in `cron-steps.test.ts`, with turns the test lets end when it chooses: what is held
 * here is that they start together, what each is told, what is joined, where the run goes, and what a list of them
 * must be. Commands are real ones, run by `sh`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { CronSection, Job, JobStep, JobTarget, TogetherStep, ToolContext } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { CronStore, type JobInput } from "@/modules/cron/cron.store.ts";
import { jobGoal } from "@/modules/cron/prompts.ts";
import { proposalCard } from "@/modules/cron/proposals.ts";
import { CronScheduler, type CronExecutors, type JobTurnRequest, type JobTurnResult } from "@/modules/cron/scheduler.ts";
import { stepsFrom } from "@/modules/cron/step-input.ts";
import { WatchStore } from "@/modules/cron/watch.store.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { unknownStepAgent } from "@/modules/web/control/routes/cron.ts";
import { eventually } from "../helpers.ts";

const DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-cron-together-"));

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

let db: SqliteDb;
let store: CronStore;

const turn = (id: string, message: string, more: { agentId?: string; name?: string } = {}): TogetherStep => ({ id, kind: "agentTurn", message, ...more });
const sh = (id: string, line: string, more: { name?: string } = {}): TogetherStep => ({ id, kind: "command", argv: ["sh", "-c", line], ...more });
type Exits = Pick<JobStep, "then" | "whenFailed" | "whenEmpty" | "name" | "onlyChanged">;
const together = (id: string, steps: TogetherStep[], exits: Exits = {}): JobStep => ({ id, kind: "parallel", steps, ...exits });
const after = (id: string, message: string): JobStep => ({ id, kind: "agentTurn", message });

/**
 * A daemon's hands. A turn answers with what `answers` says for its agent; an agent in `held` is kept at work until
 * the test lets it go, so what began before it ended can be seen.
 */
function hands(answers: Record<string, JobTurnResult | Error> = {}, held: string[] = []) {
  const delivered: { target: JobTarget; text: string }[] = [];
  const turns: JobTurnRequest[] = [];
  const gates = new Map<string, () => void>();
  const executors: CronExecutors = {
    runTurn: async (request) => {
      turns.push(request);
      const agent = request.job.agentId;
      if (held.includes(agent)) await new Promise<void>((release) => gates.set(agent, release));
      const answer = answers[agent] ?? { text: `${agent} output` };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    dispatchTurn: () => true,
    deliver: async (target, text) => {
      delivered.push({ target, text });
      return { ok: true };
    },
    commandSandbox: () => ({ cwd: DIR, env: {} }),
  };
  const begun = (count: number): Promise<void> => eventually(() => turns.length >= count, 2_000, `${count} turns begun`);
  return { scheduler: new CronScheduler({ store, config: CONFIG, executors, watch: new WatchStore(db) }), delivered, turns, begun, release: (agent: string) => gates.get(agent)?.() };
}

function job(steps: JobStep[], overrides: Partial<JobInput> = {}): Job {
  return store.create({
    agentId: "nouva",
    name: "morning",
    trigger: { kind: "every", everyMs: 60_000 },
    payload: { kind: "steps", steps },
    target: { gatewayId: "telegram:main", chatId: "12345" },
    createdBy: "tester",
    ...overrides,
  });
}

const lastRun = (jobId: string) => store.runs(jobId)[0]!;
const parts = (jobId: string) => lastRun(jobId).steps?.[0]?.parts?.map((part) => `${part.id}:${part.status}`);
const refusal = (steps: unknown): string => {
  try {
    job(stepsFrom(steps));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "accepted";
};

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  db = openDatabase(join(DIR, "t.db"));
  migrate(db);
  store = new CronStore({ db, config: CONFIG, timezone: "UTC", now: () => Date.parse("2026-08-18T10:00:00Z") });
});

afterEach(() => {
  db.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe("steps at the same time", () => {
  test("start together, each told it is one of several, and the step ends when the last of them has", async () => {
    const made = job([together("ask", [turn("a", "Read the news.", { agentId: "nix" }), turn("b", "Read the calendar.", { agentId: "nox" }), sh("c", "printf 'three tickets open'")]), after("sum", "Write the morning note.")]);
    const { scheduler, turns, begun, release, delivered } = hands({ nix: { text: "Nothing new." }, nox: { text: "Two meetings." }, nouva: { text: "The note." } }, ["nix", "nox"]);

    const running = scheduler.runNow(made.id, "tester");
    await begun(2);
    // Both turns have begun and neither has ended: the second did not wait for the first.
    expect(turns.map((one) => one.job.agentId)).toEqual(["nix", "nox"]);
    // The command ended meanwhile, and the run is still at this step: a run at work can be read, part by part.
    await eventually(() => parts(made.id)?.[2] === "c:done", 2_000, "the command's end");
    expect(parts(made.id)).toEqual(["a:running", "b:running", "c:done"]);
    expect(lastRun(made.id).steps?.map((step) => `${step.id}:${step.status}`)).toEqual(["ask:running"]);
    // Let go in the other order: the step after them has not begun while one is still at work.
    release("nox");
    await eventually(() => parts(made.id)?.[1] === "b:done", 2_000, "nox's end");
    expect(parts(made.id)).toEqual(["a:running", "b:done", "c:done"]);
    expect(turns).toHaveLength(2);
    release("nix");
    const outcome = await running;

    for (const [index, what] of ["Read the news.", "Read the calendar."].entries()) {
      expect(turns[index]!.message.startsWith(what)).toBe(true);
      expect(turns[index]!.message).toContain("This is one of 3 steps that run at the same time, as step 1 of 2 of the job. Your reply is joined with the others', each under its name, and handed to the step after them, not sent to anyone.");
      expect(turns[index]!.message).not.toContain("This is step 1 of 2 of the job.");
    }
    // Joined in the order they are written, not the order they ended, each under its name, with no model between.
    const joined = "**nix**\nNothing new.\n\n**nox**\nTwo meetings.\n\n**`sh -c printf 'three tickets open'`**\nthree tickets open";
    expect(lastRun(made.id).steps?.[0]).toMatchObject({ id: "ask", kind: "parallel", status: "done", said: joined });
    expect(parts(made.id)).toEqual(["a:done", "b:done", "c:done"]);
    expect(turns[2]!.message).toContain("3 steps at the same time ran before this step and said what is below.");
    expect(turns[2]!.message).toContain(joined);
    expect(delivered.map((one) => one.text)).toEqual(["The note."]);
    expect(outcome).toMatchObject({ status: "success", result: "The note." });
  });

  test("as the last step, their joined words are the run's report, under the names a person gave them", async () => {
    const made = job([together("ask", [turn("a", "Read the news.", { agentId: "nix", name: "News" }), sh("c", "printf 'three tickets open'", { name: "Tickets" })])]);
    const { scheduler, turns, delivered } = hands({ nix: { text: "Nothing new." } });
    const outcome = await scheduler.runNow(made.id, "tester");
    expect(turns[0]!.message).toContain("This is one of 2 steps that run at the same time, as step 1 of 1 of the job. Your reply is joined with the others', each under its name.");
    expect(turns[0]!.message).not.toContain("handed to the step after them");
    expect(delivered.map((one) => one.text)).toEqual(["**News**\nNothing new.\n\n**Tickets**\nthree tickets open"]);
    expect(outcome.status).toBe("success");
  });

  test("the job's own agent may be one of them, and each agent's turn is its own", async () => {
    const made = job([together("ask", [turn("a", "Mine."), turn("b", "Theirs.", { agentId: "nix" })])]);
    const { scheduler, turns } = hands();
    await scheduler.runNow(made.id, "tester");
    expect(turns.map((one) => one.job.agentId).sort()).toEqual(["nix", "nouva"]);
    // Weighed against its own part, not the whole list.
    expect(jobGoal(turns.find((one) => one.job.agentId === "nix")!.job)).toBe('Scheduled job "morning": Theirs.');
  });

  test("one that failed is the step's failed exit: the run fails naming it, and what the others said is kept on the run", async () => {
    const made = job([together("ask", [turn("a", "A.", { agentId: "nix" }), turn("b", "B.", { agentId: "nox" })]), after("sum", "Sum up.")]);
    const { scheduler, turns, delivered } = hands({ nix: { text: "", error: "the model refused" }, nox: { text: "Two meetings." } });
    const outcome = await scheduler.runNow(made.id, "tester");
    expect(outcome).toMatchObject({ status: "error", result: "step 1 of 2, 2 steps at the same time failed: nix: the model refused" });
    expect(parts(made.id)).toEqual(["a:failed", "b:done"]);
    expect(lastRun(made.id).steps?.[0]?.parts?.[1]?.said).toBe("Two meetings.");
    // The step after them never ran, and what is sent is the failure, not half a report.
    expect(turns).toHaveLength(2);
    expect(delivered.map((one) => one.text).join("\n")).toContain("Scheduled job **morning** failed.");
    expect(delivered.map((one) => one.text).join("\n")).not.toContain("Two meetings.");
  });

  test("a failure that goes on hands the next step what the others said and which failed, why", async () => {
    const made = job([together("ask", [turn("a", "A.", { agentId: "nix" }), turn("b", "B.", { agentId: "nox" }), sh("c", "exit 3")], { whenFailed: { to: "tell" } }), after("tell", "Say what happened.")]);
    const { scheduler, turns } = hands({ nix: { text: "", error: "the model refused" }, nox: { text: "Two meetings." }, nouva: { text: "Told." } });
    const outcome = await scheduler.runNow(made.id, "tester");
    expect(outcome.status).toBe("success");
    const message = turns.find((one) => one.job.agentId === "nouva")!.message;
    expect(message).toContain("Step 1 of 2, 3 steps at the same time ran before this step and failed. What it said is below");
    expect(message).toContain("**nox**\nTwo meetings.\n\n**nix** failed: the model refused\n\n**`sh -c exit 3`** failed: exit 3");
  });

  test("an agent that is asleep or busy is that one's failure, not the end of the run: the others' work stands", async () => {
    const made = job([together("ask", [turn("a", "A.", { agentId: "nix" }), turn("b", "B.", { agentId: "nox" })], { whenFailed: "next" }), after("sum", "Sum up.")]);
    const { scheduler, turns } = hands({ nix: { text: "", skipped: "agent asleep" }, nox: { text: "Two meetings." }, nouva: { text: "Done." } });
    const outcome = await scheduler.runNow(made.id, "tester");
    // A step alone would have ended the run as skipped, here; this one goes on with what it has.
    expect(outcome).toMatchObject({ status: "success", result: "Done." });
    expect(parts(made.id)).toEqual(["a:failed", "b:done"]);
    expect(turns.find((one) => one.job.agentId === "nouva")!.message).toContain("**nix** failed: agent asleep");
  });

  test("one that throws is its own failure, and the others are kept", async () => {
    const made = job([together("ask", [turn("a", "A.", { agentId: "nix" }), turn("b", "B.", { agentId: "nox" })])]);
    const { scheduler } = hands({ nix: new Error("the turn broke"), nox: { text: "Two meetings." } });
    const outcome = await scheduler.runNow(made.id, "tester");
    expect(outcome).toMatchObject({ status: "error", result: "step 1 of 1, 2 steps at the same time failed: nix: the turn broke" });
    expect(parts(made.id)).toEqual(["a:failed", "b:done"]);
  });

  test("the daemon going down under one of them ends the run as interrupted", async () => {
    const made = job([together("ask", [turn("a", "A.", { agentId: "nix" }), turn("b", "B.", { agentId: "nox" })], { whenFailed: "next" }), after("sum", "Sum up.")]);
    const { scheduler, turns } = hands({ nix: { text: "", interrupted: "the daemon restarted" }, nox: { text: "Two meetings." } });
    const outcome = await scheduler.runNow(made.id, "tester");
    expect(outcome).toMatchObject({ status: "interrupted", result: "step 1 of 2, 2 steps at the same time: nix: the daemon restarted" });
    expect(turns).toHaveLength(2);
    expect(parts(made.id)).toEqual(["a:interrupted", "b:done"]);
  });

  test("with nothing to say from any of them it is the step's empty exit; one with nothing to say among others is left out", async () => {
    const quiet = job([together("ask", [turn("a", "A.", { agentId: "nix" }), sh("c", "true")]), after("sum", "Sum up.")]);
    const none = hands({ nix: { text: "  " } });
    expect(await none.scheduler.runNow(quiet.id, "tester")).toMatchObject({ status: "success", result: "step 1 of 2, 2 steps at the same time had nothing to say: the run ended there" });
    expect(none.delivered).toEqual([]);
    expect(parts(quiet.id)).toEqual(["a:empty", "c:empty"]);

    const some = hands({ nix: { text: "Nothing new." } });
    const made = job([together("ask", [turn("a", "A.", { agentId: "nix" }), sh("c", "true")])], { name: "partly" });
    await some.scheduler.runNow(made.id, "tester");
    expect(some.delivered.map((one) => one.text)).toEqual(["**nix**\nNothing new."]);
  });

  test("each of them reads the webhook's body the run was set off with", async () => {
    const made = job([together("ask", [turn("a", "Look at it.", { agentId: "nix" }), sh("c", "cat")])], { trigger: { kind: "webhook", token: "t".repeat(32) } as never });
    const { scheduler, turns, delivered } = hands({ nix: { text: "Seen." } });
    await scheduler.runNow(made.id, "webhook", { body: '{"issue":7}' });
    expect(turns[0]!.message).toContain('{"issue":7}');
    expect(delivered.map((one) => one.text).join("\n")).toContain('**`sh -c cat`**\n{"issue":7}');
  });

  test("together they are held to what a step is shown: when they are longer, each is cut to its share", async () => {
    const made = job([together("ask", [turn("a", "A.", { agentId: "nix" }), turn("b", "B.", { agentId: "nox" })]), after("sum", "Sum up.")]);
    const { scheduler, turns } = hands({ nix: { text: "n".repeat(7000) }, nox: { text: "o".repeat(3000) }, nouva: { text: "ok" } });
    await scheduler.runNow(made.id, "tester");
    const message = turns.find((one) => one.job.agentId === "nouva")!.message;
    // Ten thousand characters between them, eight thousand shown: each has four thousand.
    expect(message.includes(`${"n".repeat(4000)}\n…(cut, 7000 characters in all)`)).toBe(true);
    expect(message.includes("n".repeat(4001))).toBe(false);
    // The shorter one is whole: one long answer does not push the others out.
    expect(message.includes(`**nox**\n${"o".repeat(3000)}\n`)).toBe(true);
    // Short enough together, nothing is cut.
    const short = hands({ nix: { text: "n".repeat(7000) }, nox: { text: "short" }, nouva: { text: "ok" } });
    await short.scheduler.runNow(made.id, "tester");
    expect(short.turns.find((one) => one.job.agentId === "nouva")!.message.includes("n".repeat(7000))).toBe(true);
  });

  test("what a turn of one of them was held from doing is on the run, as a step's own is", async () => {
    const held = { keys: ["mail:someone@example.com"], label: "send an email", reason: "the job did not name where it sends" };
    const made = job([together("ask", [turn("a", "A.", { agentId: "nix" }), turn("b", "B.", { agentId: "nox" })])]);
    const { scheduler } = hands({ nix: { text: "Drafted.", held: [held] }, nox: { text: "Nothing." } });
    await scheduler.runNow(made.id, "tester");
    expect(lastRun(made.id).held).toEqual([held]);
  });

  test("the audit keeps each command whole, inside steps at the same time too", () => {
    const rows: { action: string; details: Record<string, unknown> }[] = [];
    const audited = new CronStore({ db, config: CONFIG, timezone: "UTC", now: () => Date.parse("2026-08-18T10:00:00Z"), audit: { record: (row: never) => void rows.push(row) } as never });
    audited.create({
      agentId: "nouva",
      name: "audited",
      trigger: { kind: "every", everyMs: 60_000 },
      payload: { kind: "steps", steps: [together("ask", [turn("a", "A.", { agentId: "nix" }), sh("c", "date -u")]), after("sum", "Sum up.")] },
      target: { gatewayId: "telegram:main", chatId: "12345" },
      createdBy: "tester",
    });
    const created = rows.find((row) => Array.isArray(row.details.steps));
    expect(created?.details.steps).toEqual([{ kind: "parallel", steps: [{ kind: "agentTurn" }, { kind: "command", argv: ["sh", "-c", "date -u"] }] }, { kind: "agentTurn" }]);
  });

  test("marked to go on only when changed, it compares what they said together", async () => {
    const made = job([together("ask", [turn("a", "A.", { agentId: "nix" }), turn("b", "B.", { agentId: "nox" })], { onlyChanged: true })]);
    const first = hands({ nix: { text: "Same." }, nox: { text: "Same too." } });
    expect((await first.scheduler.runNow(made.id, "tester")).status).toBe("success");
    expect(first.delivered).toHaveLength(1);
    const again = hands({ nix: { text: "Same." }, nox: { text: "Same too." } });
    expect(await again.scheduler.runNow(made.id, "tester")).toMatchObject({ status: "success", result: "step 1 of 1, 2 steps at the same time said the same as last time: the run ended there" });
    expect(again.delivered).toEqual([]);
    const changed = hands({ nix: { text: "Same." }, nox: { text: "News." } });
    await changed.scheduler.runNow(made.id, "tester");
    expect(changed.delivered).toHaveLength(1);
  });
});

describe("what steps at the same time must be", () => {
  const a = { kind: "agentTurn", message: "A.", agentId: "nix" };
  const b = { kind: "agentTurn", message: "B.", agentId: "nox" };

  test("a written list is read with an id for each of them by its place, and what it says of itself is kept", () => {
    const [step] = stepsFrom([{ kind: "parallel", name: "Ask them", whenFailed: "next", steps: [a, { kind: "command", argv: ["date"], name: "Clock", then: "end" }] }, { kind: "agentTurn", message: "Sum up." }]);
    expect(step).toEqual({
      id: "s1",
      name: "Ask them",
      whenFailed: "next",
      kind: "parallel",
      steps: [{ id: "s1-1", kind: "agentTurn", message: "A.", agentId: "nix" }, { id: "s1-2", name: "Clock", kind: "command", argv: ["date"] }],
    });
    expect(refusal([{ kind: "parallel", steps: [a, b] }])).toBe("accepted");
  });

  test("two to five, each an agent's turn or a command, with no agent twice and no id another step has", () => {
    expect(refusal([{ kind: "parallel", steps: [a] }])).toBe("step 1: steps at the same time are 2 to 5.");
    expect(refusal([{ kind: "parallel" }])).toBe("step 1: steps at the same time are 2 to 5.");
    expect(refusal([{ kind: "parallel", steps: [a, b, { ...a, agentId: "n3" }, { ...a, agentId: "n4" }, { ...a, agentId: "n5" }, { ...a, agentId: "n6" }] }])).toBe("step 1: steps at the same time are 2 to 5.");
    expect(refusal([{ kind: "parallel", steps: [a, { kind: "mission", goal: "Ship it." }] }])).toBe("step 1, part 2 must be an agent's turn or a command: a mission or a wait for a person is a step of its own.");
    expect(refusal([{ kind: "parallel", steps: [a, { kind: "parallel", steps: [a, b] }] }])).toBe("step 1, part 2 must be an agent's turn or a command: a mission or a wait for a person is a step of its own.");
    expect(refusal([{ kind: "parallel", steps: [a, { ...b, agentId: "nix" }] }])).toBe("step 1: nix has two turns at the same time. An agent takes one at a time: give the second a step of its own.");
    // Left out, the agent is the job's own: twice is still twice.
    expect(refusal([{ kind: "parallel", steps: [{ kind: "agentTurn", message: "A." }, { kind: "agentTurn", message: "B.", agentId: "nouva" }] }])).toBe("step 1: nouva has two turns at the same time. An agent takes one at a time: give the second a step of its own.");
    expect(refusal([{ kind: "parallel", steps: [{ ...a, id: "sum" }, b] }, { id: "sum", kind: "agentTurn", message: "Sum up." }])).toBe("step 1, part 1 needs an id no other step of the job has: lower-case letters, digits, - and _, at most 24.");
    expect(refusal([{ kind: "parallel", steps: [{ ...a, id: "same" }, { ...b, id: "same" }] }])).toBe("step 1, part 2 needs an id no other step of the job has: lower-case letters, digits, - and _, at most 24.");
    expect(refusal([{ kind: "parallel", steps: [a, { ...b, message: "  " }] }])).toBe("step 1, part 2: an agent turn needs a message.");
    expect(refusal([{ kind: "parallel", steps: [a, { kind: "command", argv: [] }] }])).toBe("step 1, part 2: a command needs an argv array.");
    expect(refusal([{ kind: "telepathy" }])).toBe("step 1 must be a message, an agent's turn, a command, a mission, a wait for a person or several steps at the same time.");
  });

  test("an agent one of them names must exist, said with its place", () => {
    const deps = { registry: { get: (id: string) => (id === "nix" ? {} : undefined) } } as never;
    expect(unknownStepAgent(deps, { kind: "steps", steps: stepsFrom([{ kind: "agentTurn", message: "First." }, { kind: "parallel", steps: [a, { ...b, agentId: "ghost" }] }]) })).toBe('step 2, part 2: no agent "ghost": a step must name one that exists');
    expect(unknownStepAgent(deps, { kind: "steps", steps: stepsFrom([{ kind: "parallel", steps: [a, { kind: "command", argv: ["date"] }] }]) })).toBeNull();
  });

  test("a person asked to turn one on reads each of them, and what the run is weighed against names them", () => {
    const made = job(stepsFrom([{ kind: "parallel", steps: [a, { kind: "command", argv: ["gh", "issue", "list"] }] }, { kind: "agentTurn", message: "Sum up." }]));
    const card = proposalCard(made, "every morning", { buttons: false });
    expect(card).toContain('1. at the same time, their words joined:\n   - nix works on: "A."\n   - runs `gh issue list` on this machine, with no model With nothing to say, the run ends there.');
    expect(jobGoal(made)).toBe('Scheduled job "morning": 1. at the same time: A.; report on the output of `gh issue list` 2. Sum up.');
  });
});

describe("an agent proposes steps at the same time", () => {
  function tool(agents = ["nouva", "nix", "nox"]) {
    const posted: Job[] = [];
    const made = createScheduleTool({ chats: () => ({ chats: [], othersGateways: [] }), store, timezone: () => "UTC", agentExists: (id) => agents.includes(id), post: async (proposed) => (posted.push(proposed), true) });
    const ctx = { agentId: "nouva", gatewayId: "telegram:main", chatId: "8142", senderId: "8142", workspaceRoots: [] } as unknown as ToolContext;
    return { propose: (args: Record<string, unknown>) => made.execute({ name: "morning", when: "cron 0 7 * * *", ...args }, ctx), posted, made };
  }

  test("written as steps are, each of them a prompt or a command, and the list is what a person wrote would be", async () => {
    const { propose, posted, made } = tool();
    const answer = await propose({ steps: [{ name: "Ask them", together: [{ prompt: "Read the news.", agent: "nix", name: "News" }, { command: "gh issue list" }], if_failed: "next" }, { prompt: "Write the morning note." }] });
    expect(answer.isError).toBe(false);
    expect(posted[0]!.payload).toEqual({
      kind: "steps",
      steps: [
        {
          id: "s1",
          name: "Ask them",
          whenFailed: "next",
          kind: "parallel",
          steps: [{ id: "s1-1", name: "News", kind: "agentTurn", message: "Read the news.", agentId: "nix" }, { id: "s1-2", kind: "command", argv: ["sh", "-lc", "gh issue list"] }],
        },
        { id: "s2", kind: "agentTurn", message: "Write the morning note." },
      ],
    });
    // The model is told what it is and how many: the fields are a step's own, and are not written out twice.
    const steps = (made.definition.parameters as { properties: { steps: { description: string; items: { properties: Record<string, unknown> } } } }).properties.steps;
    expect(steps.description).toContain("or `together` (2 to 5 steps of `prompt` or `command` begun at once, their words joined under each one's name)");
    expect(steps.items.properties.together).toEqual({ type: "array", items: { type: "object" } });
  });

  test("what cannot start beside others is refused with its place, and so is a command a call from outside would set off", async () => {
    const { propose, posted } = tool();
    const said = async (steps: unknown[], more: Record<string, unknown> = {}) => (await propose({ steps, ...more })).content;
    const news = { prompt: "Read the news.", agent: "nix" };
    expect(await said([{ together: [news, { mission: "Ship it." }] }])).toBe("Step 1: `together`, part 2: only a `prompt` or a `command` starts beside others. A `mission` or a `text` is a step of its own.");
    expect(await said([{ together: [news, { text: "Good morning." }] }])).toBe("Step 1: `together`, part 2: only a `prompt` or a `command` starts beside others. A `mission` or a `text` is a step of its own.");
    expect(await said([{ together: [{}, news] }])).toBe("Step 1: `together`, part 1: give a `prompt` or a `command`.");
    expect(await said([{ together: [{ prompt: "Look.", agent: "ghost" }, news] }])).toBe("Step 1: `together`, part 1: there is no agent called ghost.");
    // How many, and no agent twice, are the store's to say, as for a list a person wrote.
    expect(await said([{ together: [news] }])).toContain("step 1: steps at the same time are 2 to 5.");
    expect(await said([{ together: [news, { prompt: "Again.", agent: "nix" }] }])).toContain("step 1: nix has two turns at the same time.");
    expect(await said([{ together: [news, { command: "date" }] }], { when: "webhook" })).toBe("A webhook that runs a command is made by an admin from the dashboard, not proposed.");
    expect(posted).toEqual([]);
  });
});
