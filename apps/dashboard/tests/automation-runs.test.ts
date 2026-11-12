/**
 * One run read over an automation's steps (`modules/automations/lib/runs.ts`): how each step went, which were never
 * reached, the path the run took, and the words each is said in. The page only draws what these say.
 */

import { describe, expect, test } from "bun:test";
import type { JobRunSummary, StepRunOutcome } from "@nouride/wire";
import { exitTaken, live, outcomeWords, outcomesOf, pathTaken, ranFor, runWords, took, whenWords } from "@/modules/automations/lib/runs";
import type { Step } from "@/modules/automations/lib/steps";

const STEPS: Step[] = [
  { id: "check", kind: "command", argv: ["sh", "-lc", "check"], then: "end", whenFailed: "next" },
  { id: "find", kind: "agentTurn", message: "Find out why.", whenFailed: { to: "me" } },
  { id: "ok", kind: "approval", ask: "Send it?" },
  { id: "tell", kind: "systemEvent", text: "Sent.", then: "end" },
  { id: "me", kind: "systemEvent", text: "It needs you." },
];
const out = (id: string, status: StepRunOutcome["status"], more: Partial<StepRunOutcome> = {}): StepRunOutcome => ({ id, kind: STEPS.find((step) => step.id === id)?.kind ?? "command", status, startedAt: 1, ...more });
const run = (status: JobRunSummary["status"], steps?: StepRunOutcome[], more: Partial<JobRunSummary> = {}): JobRunSummary => ({ id: "run_1", jobId: "cron_1", startedAt: 1_000, status, ...(steps ? { steps } : {}), ...more });

describe("how each step went", () => {
  test("by the step's id; a step with no outcome was not reached", () => {
    const outcomes = outcomesOf(STEPS, run("waiting", [out("check", "failed"), out("find", "done"), out("ok", "waiting")]));
    expect([...outcomes.keys()]).toEqual(["check", "find", "ok"]);
    expect(outcomes.get("ok")?.status).toBe("waiting");
    expect(outcomes.has("tell")).toBe(false);
    expect(outcomesOf(STEPS, undefined).size).toBe(0);
  });

  test("a run of one thing writes no outcomes: its one step went as the run did", () => {
    const [only] = [STEPS[0]!];
    const of = (status: JobRunSummary["status"], more: Partial<JobRunSummary> = {}) => outcomesOf([only], run(status, undefined, more)).get("check");
    expect(of("success", { finishedAt: 1_400, result: "ok" })).toEqual({ id: "check", kind: "command", status: "done", said: "ok", startedAt: 1_000, ms: 400 });
    expect(of("error", { finishedAt: 6_000, result: "exit 1" })?.status).toBe("failed");
    expect(of("running")).toEqual({ id: "check", kind: "command", status: "running", startedAt: 1_000 });
    expect([of("skipped")?.status, of("interrupted")?.status, of("waiting")?.status]).toEqual(["skipped", "interrupted", "waiting"]);
    // A list whose run kept no outcomes (an older run) says nothing about its steps rather than guessing.
    expect(outcomesOf(STEPS, run("success")).size).toBe(0);
  });
});

describe("the path a run took", () => {
  test("a leg per step it left, by the exit that went with how the step ended", () => {
    expect(exitTaken("done")).toBe("then");
    expect([exitTaken("failed"), exitTaken("declined"), exitTaken("expired")]).toEqual(["whenFailed", "whenFailed", "whenFailed"]);
    expect(exitTaken("empty")).toBe("whenEmpty");
    expect([exitTaken("running"), exitTaken("waiting"), exitTaken("skipped"), exitTaken("interrupted")]).toEqual([null, null, null, null]);
  });

  test("failed, went on, and waits: two legs, and none out of the step it waits in", () => {
    expect(pathTaken(STEPS, run("waiting", [out("check", "failed"), out("find", "done"), out("ok", "waiting")]))).toEqual([
      { from: 0, exit: "whenFailed", to: 1 },
      { from: 1, exit: "then", to: 2 },
    ]);
  });

  test("a jump is a leg to the step it lands on, and the end is the end", () => {
    expect(pathTaken(STEPS, run("success", [out("check", "failed"), out("find", "failed"), out("me", "done")]))).toEqual([
      { from: 0, exit: "whenFailed", to: 1 },
      { from: 1, exit: "whenFailed", to: 4 },
      { from: 4, exit: "then", to: "end" },
    ]);
    expect(pathTaken(STEPS, run("success", [out("check", "done")]))).toEqual([{ from: 0, exit: "then", to: "end" }]);
    expect(pathTaken(STEPS, run("skipped", [out("check", "failed"), out("find", "done"), out("ok", "declined")]))).toContainEqual({ from: 2, exit: "whenFailed", to: "end" });
    expect(pathTaken(STEPS, undefined)).toEqual([]);
  });
});

describe("the words", () => {
  test("how long something took, to the unit a person reads", () => {
    expect([took(400), took(5_000), took(9_999), took(48_000), took(180_000), took(2 * 3_600_000)]).toEqual(["0.4 s", "5.0 s", "10.0 s", "48 s", "3 min", "2 h"]);
    expect(ranFor({ startedAt: 1_000, finishedAt: 1_400 })).toBe(400);
    expect(ranFor({ startedAt: 1_000 }, 4_000)).toBe(3_000);
  });

  test("each way a step can have gone, and the colour it is said in", () => {
    const said = (status: StepRunOutcome["status"], more: Partial<StepRunOutcome> = {}) => outcomeWords(out("check", status, more));
    expect(said("done", { ms: 48_000 })).toEqual({ label: "Done in 48 s", tone: "done" });
    expect(said("failed", { ms: 5_000 })).toEqual({ label: "Failed after 5.0 s", tone: "failed" });
    expect(said("empty")).toEqual({ label: "Nothing to say", tone: "quiet" });
    expect(said("running")).toEqual({ label: "Working", tone: "working" });
    expect(said("declined", { by: "Gading" })).toEqual({ label: "Stopped by Gading", tone: "quiet" });
    expect(said("declined")).toEqual({ label: "Stopped", tone: "quiet" });
    expect(said("expired")).toEqual({ label: "Nobody answered", tone: "quiet" });
    expect(said("skipped")).toEqual({ label: "Skipped", tone: "quiet" });
    expect(said("interrupted")).toEqual({ label: "Cut off by a restart", tone: "quiet" });
    // A wait for a person is what needs you; a wait for a mission is the automation at work.
    expect(outcomeWords(out("ok", "waiting"))).toEqual({ label: "Waiting for you", tone: "needs" });
    expect(outcomeWords({ id: "m", kind: "mission", status: "waiting", startedAt: 1 })).toEqual({ label: "Waiting for its mission", tone: "working" });
  });

  test("a whole run, for a list of runs", () => {
    expect(runWords({ status: "success" })).toEqual({ label: "Done", tone: "done" });
    expect(runWords({ status: "error" })).toEqual({ label: "Failed", tone: "failed" });
    expect(runWords({ status: "running" })).toEqual({ label: "Working", tone: "working" });
    expect(runWords({ status: "waiting", waiting: { kind: "approval", step: "ok", since: 1, until: 2, ask: "Go?" } })).toEqual({ label: "Waiting for you", tone: "needs" });
    expect(runWords({ status: "waiting", waiting: { kind: "mission", step: "m", missionId: "msn_1", since: 1 } })).toEqual({ label: "Waiting for a mission", tone: "working" });
    expect([runWords({ status: "skipped" }).label, runWords({ status: "interrupted" }).label]).toEqual(["Skipped", "Cut off by a restart"]);
    expect([live({ status: "running" }), live({ status: "waiting" }), live({ status: "success" }), live(undefined)]).toEqual([true, true, false, false]);
  });

  test("when it was, by the day: today, yesterday, tomorrow, then the date", () => {
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 40).getTime();
    expect(whenWords(at(12, 9), now)).toMatch(/^Today \d/);
    // Calendar days, not hours: last night is yesterday at ten this morning.
    expect(whenWords(at(11, 23), now)).toMatch(/^Yesterday \d/);
    expect(whenWords(at(13, 7), now)).toMatch(/^Tomorrow \d/);
    expect(whenWords(at(1, 9), now)).not.toMatch(/Today|Yesterday|Tomorrow|2026/);
    expect(whenWords(new Date(2025, 10, 1, 9, 0).getTime(), now)).toContain("2025");
  });
});
