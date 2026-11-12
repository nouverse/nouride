/**
 * A list of steps as the Automations page changes it (`modules/automations/lib/steps.ts`): every rule the server holds
 * a list to (`cron/validate.ts`) is held by the page first, so it sends nothing the server would refuse. The one that
 * cannot be left to a refusal is that a path only points forward: a move or a delete that would break it puts the path
 * back to its default and names it.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EXIT, STEPS_MAX, argvOf, asKind, blankStep, branchesOf, canWatch, duplicateStep, exitFrom, exitOf, exitValue, exitsOf, forward, insertStep, isLast, landsAt, mainText, moveStep, newStepId,
  refusedStep, removeStep, replaceStep, setExit, shellLine, stepProblems, watching, type Step,
} from "@/modules/automations/lib/steps";

const say = (id: string, more: Partial<Step> = {}): Step => ({ id, kind: "systemEvent", text: `say ${id}`, ...more }) as Step;
const run = (id: string, more: Partial<Step> = {}): Step => ({ id, kind: "command", argv: ["sh", "-lc", `run ${id}`], ...more }) as Step;
const ids = (steps: readonly Step[]) => steps.map((step) => step.id);

describe("where a run goes from a step", () => {
  test("by default: on when it is done, to the end when it failed or said nothing", () => {
    expect(DEFAULT_EXIT).toEqual({ then: "next", whenFailed: "end", whenEmpty: "end" });
    expect(exitOf(run("a"), "then")).toBe("next");
    expect(exitOf(run("a", { whenFailed: { to: "c" } }), "whenFailed")).toEqual({ to: "c" });
  });

  test("lands on a later step, or the end: the step after the last one is the end", () => {
    const steps = [run("a", { whenFailed: { to: "c" }, whenEmpty: "next" }), say("b"), say("c", { then: "end" })];
    expect(landsAt(steps, 0, "then")).toBe(1);
    expect(landsAt(steps, 0, "whenFailed")).toBe(2);
    expect(landsAt(steps, 0, "whenEmpty")).toBe(1);
    expect(landsAt(steps, 1, "whenFailed")).toBe("end");
    expect(landsAt(steps, 2, "then")).toBe("end");
    // Going on from the last step is the run's end too.
    expect(landsAt([say("a")], 0, "then")).toBe("end");
  });

  test("only the paths a kind can take are offered, and one written elsewhere is still shown", () => {
    expect(exitsOf(run("a"))).toEqual(["then", "whenFailed", "whenEmpty"]);
    expect(exitsOf({ id: "a", kind: "agentTurn", message: "x" })).toEqual(["then", "whenFailed", "whenEmpty"]);
    expect(exitsOf(say("a"))).toEqual(["then"]);
    expect(exitsOf({ id: "a", kind: "mission", goal: "x" })).toEqual(["then", "whenFailed"]);
    expect(exitsOf({ id: "a", kind: "approval", ask: "x" })).toEqual(["then", "whenFailed"]);
    expect(exitsOf(say("a", { whenEmpty: "next" }))).toEqual(["then", "whenEmpty"]);
  });

  test("the paths a step says for itself are its branches; a default written out is none, and only a jump past the next step is a line", () => {
    const steps = [run("a", { then: "end", whenFailed: "next", whenEmpty: "end" }), say("b", { then: { to: "c" } }), say("c"), say("d")];
    expect(branchesOf(steps, 0)).toEqual([{ exit: "then", to: "end", jump: false }, { exit: "whenFailed", to: 1, jump: false }]);
    // To the step right after: a path of its own, and the line to it is the one already there.
    expect(branchesOf(steps, 1)).toEqual([{ exit: "then", to: 2, jump: false }]);
    expect(branchesOf([run("a", { whenFailed: { to: "d" } }), say("b"), say("c"), say("d")], 0)).toEqual([{ exit: "whenFailed", to: 3, jump: true }]);
    expect(branchesOf(steps, 2)).toEqual([]);
  });

  test("the last step has no branch, whatever it holds: after it the run ends whichever way it went", () => {
    const held = run("b", { then: "end", whenFailed: "next", whenEmpty: "next" });
    expect(branchesOf([run("a"), held], 1)).toEqual([]);
    expect(branchesOf([held], 0)).toEqual([]);
    // The same step with one after it: each of its paths is a branch again.
    expect(branchesOf([run("a"), held, say("c")], 1).map((branch) => branch.exit)).toEqual(["then", "whenFailed", "whenEmpty"]);
    expect([isLast([run("a"), held], 1), isLast([run("a"), held], 0), isLast([held], 0)]).toEqual([true, false, true]);
  });

  test("set: a later step, on, or the end; the default is left out, and a step that is not after it is not taken", () => {
    const steps = [run("a"), say("b"), say("c")];
    expect(setExit(steps, 0, "whenFailed", { to: "c" })[0]).toEqual(run("a", { whenFailed: { to: "c" } }));
    expect(setExit(steps, 0, "whenFailed", "next")[0]).toEqual(run("a", { whenFailed: "next" }));
    // Back to the default: the step does not say.
    expect(setExit(setExit(steps, 0, "whenFailed", "next"), 0, "whenFailed", "end")[0]).toEqual(run("a"));
    expect(setExit(steps, 0, "then", "next")[0]).toEqual(run("a"));
    // Itself, an earlier step, a step that is not there: none is taken.
    for (const to of ["b", "a", "zz"]) expect(setExit(steps, 1, "then", { to })).toEqual(steps);
    expect(exitFrom(exitValue({ to: "c" }))).toEqual({ to: "c" });
    expect([exitFrom("next"), exitFrom("end")]).toEqual(["next", "end"]);
  });
});

describe("a path kept forward", () => {
  test("a step moved above the one that points at it: that path is back to its default, and named", () => {
    const steps = [run("a", { whenFailed: { to: "c" } }), say("b"), say("c")];
    const moved = moveStep(steps, 2, 0);
    expect(ids(moved.steps)).toEqual(["c", "a", "b"]);
    expect(moved.steps[1]).toEqual(run("a"));
    expect(moved.reset).toEqual([{ id: "a", exit: "whenFailed", why: "moved" }]);
  });

  test("a step moved below its own target loses the path; one still above it keeps it", () => {
    const steps = [run("a", { whenFailed: { to: "b" } }), say("b"), say("c")];
    expect(moveStep(steps, 0, 2)).toEqual({ steps: [say("b"), say("c"), run("a")], reset: [{ id: "a", exit: "whenFailed", why: "moved" }] });
    const kept = moveStep([run("a", { whenFailed: { to: "c" } }), say("b"), say("c")], 0, 1);
    expect(kept).toEqual({ steps: [say("b"), run("a", { whenFailed: { to: "c" } }), say("c")], reset: [] });
  });

  test("a deleted step takes every path to it: each is back to its default, as removed", () => {
    const steps = [run("a", { whenFailed: { to: "c" }, whenEmpty: { to: "c" } }), say("b", { then: { to: "c" } }), say("c")];
    const removed = removeStep(steps, 2);
    expect(removed.steps).toEqual([run("a"), say("b")]);
    expect(removed.reset).toEqual([{ id: "a", exit: "whenFailed", why: "removed" }, { id: "a", exit: "whenEmpty", why: "removed" }, { id: "b", exit: "then", why: "removed" }]);
  });

  test("`forward` leaves `next`, `end` and every forward jump alone", () => {
    const steps = [run("a", { then: "end", whenFailed: "next", whenEmpty: { to: "b" } }), say("b")];
    expect(forward(steps)).toEqual({ steps, reset: [] });
  });

  test("a move to where it is, or out of the list, changes nothing", () => {
    const steps = [say("a"), say("b")];
    for (const [from, to] of [[0, 0], [0, 2], [-1, 0], [2, 0]] as const) expect(moveStep(steps, from, to)).toEqual({ steps, reset: [] });
  });
});

describe("adding and copying", () => {
  test("a new step has an id no step has, as the server names one by its place", () => {
    expect(newStepId([])).toBe("s1");
    expect(newStepId([say("s1"), say("s2")])).toBe("s3");
    expect(newStepId([say("s3"), say("x")])).toBe("s4");
    expect(blankStep("command", [say("s1")])).toEqual({ id: "s2", kind: "command", argv: [] });
    expect(blankStep("approval", [])).toEqual({ id: "s1", kind: "approval", ask: "" });
    expect(blankStep("mission", [])).toEqual({ id: "s1", kind: "mission", goal: "" });
    expect(blankStep("agentTurn", [])).toEqual({ id: "s1", kind: "agentTurn", message: "" });
    expect(blankStep("systemEvent", [])).toEqual({ id: "s1", kind: "systemEvent", text: "" });
  });

  test("inserted at a place, the paths around it still point forward; one whose id is taken gets its own", () => {
    const steps = [run("a", { whenFailed: { to: "b" } }), say("b")];
    expect(ids(insertStep(steps, 1, say("x")).steps)).toEqual(["a", "x", "b"]);
    expect(insertStep(steps, 1, say("x")).reset).toEqual([]);
    expect(ids(insertStep(steps, 99, say("b")).steps)).toEqual(["a", "b", "s3"]);
  });

  test("at the most a job runs, nothing is added: by a new step or by a copy", () => {
    const full = Array.from({ length: STEPS_MAX }, (_, n) => say(`s${n + 1}`));
    expect(STEPS_MAX).toBe(20);
    expect(insertStep(full, 3, say("x")).steps).toEqual(full);
    expect(duplicateStep(full, 0).steps).toEqual(full);
  });

  test("a copy stands right after its step with an id of its own, its name marked, its paths kept", () => {
    const steps = [run("a", { name: "Check", whenFailed: { to: "c" } }), say("b"), say("c")];
    const copied = duplicateStep(steps, 0);
    expect(ids(copied.steps)).toEqual(["a", "s4", "b", "c"]);
    expect(copied.steps[1]).toEqual(run("a", { id: "s4", name: "Check copy", whenFailed: { to: "c" } }));
    expect(copied.reset).toEqual([]);
    expect(duplicateStep(steps, 9).steps).toEqual(steps);
    expect(replaceStep(steps, 1, say("z"))).toEqual([steps[0]!, say("z"), steps[2]!]);
  });
});

describe("a step's words", () => {
  test("a command is the line a person types: written as a shell line, read back as one, spaces kept while it is typed", () => {
    expect(argvOf("ls -la")).toEqual(["sh", "-lc", "ls -la"]);
    expect(argvOf("ls ")).toEqual(["sh", "-lc", "ls "]);
    expect(argvOf("")).toEqual([]);
    expect(shellLine(["sh", "-lc", "ls -la | wc -l"])).toBe("ls -la | wc -l");
    // One written elsewhere, as its parts: joined, which the box shows.
    expect(shellLine(["git", "status"])).toBe("git status");
  });

  test("another kind keeps its place, its name, its words and the paths the new kind can take", () => {
    const step = run("a", { name: "Check", then: "end", whenFailed: { to: "c" }, whenEmpty: "next" });
    expect(asKind(step, "agentTurn")).toEqual({ id: "a", name: "Check", then: "end", whenFailed: { to: "c" }, whenEmpty: "next", kind: "agentTurn", message: "run a" });
    expect(asKind(step, "systemEvent")).toEqual({ id: "a", name: "Check", then: "end", kind: "systemEvent", text: "run a" });
    expect(asKind(step, "approval")).toEqual({ id: "a", name: "Check", then: "end", whenFailed: { to: "c" }, kind: "approval", ask: "run a" });
    expect(asKind({ id: "a", kind: "agentTurn", message: "do it", agentId: "nix" }, "mission")).toEqual({ id: "a", kind: "mission", goal: "do it", agentId: "nix" });
    expect(asKind(say("a"), "command")).toEqual({ id: "a", kind: "command", argv: ["sh", "-lc", "say a"] });
    expect(asKind(step, "command")).toBe(step);
    expect(mainText({ id: "a", kind: "approval", ask: "Go?" })).toBe("Go?");
  });
});

describe("a step that goes on only when what it says changes", () => {
  const turn: Step = { id: "b", kind: "agentTurn", message: "look" };
  const mission: Step = { id: "c", kind: "mission", goal: "do" };
  const wait: Step = { id: "d", kind: "approval", ask: "Go?" };

  test("can be a command, an agent's turn or a mission: never a message or a wait, which the server refuses", () => {
    expect([run("a"), turn, mission, say("e"), wait].map((step) => [step.kind, canWatch(step)])).toEqual([["command", true], ["agentTurn", true], ["mission", true], ["systemEvent", false], ["approval", false]]);
  });

  test("the mark is set as the server takes it, and taken off it is not there at all; the rest of the step is kept", () => {
    const step = run("a", { name: "Check", whenFailed: "next", timeoutMs: 5_000 } as Partial<Step>);
    expect(watching(step, true)).toEqual({ ...step, onlyChanged: true });
    expect(watching(watching(step, true), false)).toEqual(step);
    expect("onlyChanged" in watching(watching(step, true), false)).toBe(false);
    expect(watching(turn, true)).toEqual({ ...turn, onlyChanged: true });
    expect(watching(mission, true)).toEqual({ ...mission, onlyChanged: true });
    // Not on a kind that cannot hold it, whatever is asked.
    expect(watching(say("e"), true)).toEqual(say("e"));
    expect(watching(wait, true)).toEqual(wait);
  });

  test("another kind keeps the mark where it can hold it, and drops it where it cannot", () => {
    const marked = watching(run("a"), true);
    expect(asKind(marked, "agentTurn")).toEqual({ id: "a", onlyChanged: true, kind: "agentTurn", message: "run a" });
    expect(asKind(marked, "mission")).toEqual({ id: "a", onlyChanged: true, kind: "mission", goal: "run a" });
    expect(asKind(asKind(marked, "mission"), "command")).toEqual({ id: "a", onlyChanged: true, kind: "command", argv: ["sh", "-lc", "run a"] });
    expect(asKind(marked, "systemEvent")).toEqual({ id: "a", kind: "systemEvent", text: "run a" });
    expect(asKind(marked, "approval")).toEqual({ id: "a", kind: "approval", ask: "run a" });
    // A copy is marked as its step is; nothing in a marked list is something the server would refuse.
    expect(duplicateStep([marked, say("b")], 0).steps[1]).toEqual({ ...marked, id: "s3" });
    expect(stepProblems([marked, watching(turn, true), watching(mission, true)])).toEqual([]);
  });
});

describe("what the server would refuse", () => {
  const problems = (steps: Step[]) => stepProblems(steps).map((problem) => `${problem.index}: ${problem.message}`);

  test("a list with nothing wrong has no problems", () => {
    expect(stepProblems([run("a", { whenFailed: { to: "c" } }), { id: "b", kind: "agentTurn", message: "look" }, { id: "c", kind: "approval", ask: "Go?", timeoutMs: 300_000 }, { id: "d", kind: "mission", goal: "do", checks: ["test -s x"], review: false }, say("e")])).toEqual([]);
  });

  test("no steps, and more than a job runs", () => {
    expect(problems([])).toEqual(["null: Add a step: what should happen when it starts."]);
    expect(problems(Array.from({ length: 21 }, (_, n) => say(`s${n + 1}`)))).toEqual(["null: An automation runs at most 20 steps."]);
  });

  test("each kind's own field, said at its step", () => {
    expect(problems([say("a", { text: "  " } as Partial<Step>)])).toEqual(["0: Write the message to send."]);
    expect(problems([{ id: "a", kind: "agentTurn", message: "" }])).toEqual(["0: Write what to ask the agent."]);
    expect(problems([{ id: "a", kind: "command", argv: [] }, { id: "b", kind: "command", argv: ["sh", "-lc", "  "] }])).toEqual(["0: Write the command to run.", "1: Write the command to run."]);
    expect(problems([{ id: "a", kind: "mission", goal: " " }])).toEqual(["0: Write the mission's goal: what should be true when it is done."]);
    expect(problems([{ id: "a", kind: "mission", goal: "x".repeat(2001) }])).toEqual(["0: Keep the goal under 2000 characters."]);
    expect(problems([{ id: "a", kind: "mission", goal: "x", checks: Array.from({ length: 11 }, () => "true") }])).toEqual(["0: A mission takes at most 10 checks, each under 500 characters."]);
    expect(problems([{ id: "a", kind: "mission", goal: "x", review: "y".repeat(1001) }])).toEqual(["0: Keep the reviewer's words under 1000 characters."]);
    expect(problems([{ id: "a", kind: "approval", ask: "" }])).toEqual(["0: Write the question to ask."]);
    expect(problems([{ id: "a", kind: "agentTurn", message: "x", agentId: " " }])).toEqual(["0: Pick the agent for this step, or leave it to the automation's own."]);
  });

  test("a wait for a person is between 5 minutes and 7 days", () => {
    const wait = (timeoutMs: number) => problems([{ id: "a", kind: "approval", ask: "Go?", timeoutMs }]);
    expect(wait(299_999)).toEqual(["0: It can wait between 5 minutes and 7 days."]);
    expect(wait(7 * 86_400_000 + 1)).toEqual(["0: It can wait between 5 minutes and 7 days."]);
    expect(wait(300_000)).toEqual([]);
    expect(wait(7 * 86_400_000)).toEqual([]);
  });

  test("an id that is not one, or another step's, and a path that does not point forward", () => {
    expect(problems([say("Bad Id")])).toEqual(["0: This step cannot be told from another. Duplicate it and delete this one."]);
    expect(problems([say("a"), say("a")])).toEqual(["1: This step cannot be told from another. Duplicate it and delete this one."]);
    expect(problems([say("a"), say("b", { then: { to: "a" } })])).toEqual(["1: One of its paths leads to a step that is not after it."]);
    expect(problems([say("a", { then: { to: "gone" } })])).toEqual(["0: One of its paths leads to a step that is not after it."]);
  });

  test("the step a refusal names is found by its number", () => {
    expect(refusedStep("step 3: a system event needs text to deliver.")).toBe(2);
    expect(refusedStep("step 12 has the id of step 2 (a): each step's id is its own.")).toBe(11);
    expect(refusedStep("a job of steps needs at least one step.")).toBeNull();
    expect(refusedStep(undefined)).toBeNull();
  });
});
