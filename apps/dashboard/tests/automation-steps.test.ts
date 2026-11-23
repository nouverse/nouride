/**
 * A list of steps as the Automations page changes it (`modules/automations/lib/steps.ts`): every rule the server holds
 * a list to (`cron/validate.ts`) is held by the page first, so it sends nothing the server would refuse. The one that
 * cannot be left to a refusal is that a path only points forward: a move or a delete that would break it puts the path
 * back to its default and names it.
 */

import { describe, expect, test } from "bun:test";
import { addOnLine, addToLane, copyOnLine, insertOnLine, moveOnLine, removeDrawn } from "@/modules/automations/lib/paths";
import {
  DEFAULT_EXIT, STEPS_MAX, argvOf, asKind, blankStep, canWatch, exitFrom, exitOf, exitValue, exitsOf, forward, landsAt, mainText, newStepId,
  refusedStep, replaceStep, resetsBetween, setExit, shellLine, stepProblems, watching, type Step,
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
    const moved = moveOnLine(steps, 2, 0);
    expect(ids(moved)).toEqual(["c", "a", "b"]);
    expect(moved[1]).toEqual(run("a"));
    expect(resetsBetween(steps, moved)).toEqual([{ id: "a", exit: "whenFailed", why: "moved" }]);
  });

  test("a step moved below its own target loses the path; one still above it keeps it", () => {
    const steps = [run("a", { whenFailed: { to: "b" } }), say("b"), say("c")];
    const moved = moveOnLine(steps, 0, 2);
    expect(moved).toEqual([say("b"), say("c"), run("a")]);
    expect(resetsBetween(steps, moved)).toEqual([{ id: "a", exit: "whenFailed", why: "moved" }]);
    const far = [run("a", { whenFailed: { to: "c" } }), say("b"), say("c")];
    const kept = moveOnLine(far, 0, 1);
    expect(kept).toEqual([say("b"), run("a", { whenFailed: { to: "c" } }), say("c")]);
    expect(resetsBetween(far, kept)).toEqual([]);
  });

  test("a deleted step takes every path to it: each is back to its default, as removed", () => {
    const steps = [run("a", { whenFailed: { to: "c" }, whenEmpty: { to: "c" } }), say("b", { then: { to: "c" } }), say("c")];
    const removed = removeDrawn(steps, 2);
    expect(removed).toEqual([run("a"), say("b")]);
    expect(resetsBetween(steps, removed)).toEqual([{ id: "a", exit: "whenFailed", why: "removed" }, { id: "a", exit: "whenEmpty", why: "removed" }, { id: "b", exit: "then", why: "removed" }]);
  });

  test("a path the page rewrote on purpose is no reset: it names a step that is there and still ahead", () => {
    const steps = [run("a", { whenFailed: { to: "b" } }), say("b"), say("c")];
    // A step put between the two: "go on anyway" goes on to the new step.
    const wider = insertOnLine(steps, 1, say("x"));
    expect(wider).toEqual([run("a", { whenFailed: { to: "x" } }), say("x"), say("b"), say("c")]);
    expect(resetsBetween(steps, wider)).toEqual([]);
  });

  test("`forward` leaves `next`, `end` and every forward jump alone", () => {
    const steps = [run("a", { then: "end", whenFailed: "next", whenEmpty: { to: "b" } }), say("b")];
    expect(forward(steps)).toEqual({ steps, reset: [] });
  });

  test("a move to where it is, or of a step that is not there, changes nothing; nor does a move of a lane's step, which stays with its owner", () => {
    const steps = [say("a"), say("b")];
    for (const [from, to] of [[0, 0], [1, 1], [-1, 0], [2, 0], [0, -1]] as const) expect(moveOnLine(steps, from, to)).toEqual(steps);
    const laned = [run("a", { then: { to: "c" }, whenFailed: { to: "l" } }), say("l", { then: { to: "c" } }), say("c"), say("d")];
    for (const to of [0, 1, 2]) expect(moveOnLine(laned, 1, to)).toEqual(laned);
    // Its owner moves, and the lane with it.
    expect(ids(moveOnLine(laned, 0, 1))).toEqual(["c", "a", "l", "d"]);
  });

  test("the first of a lane's steps deleted: the path leads to the next one, on purpose, and nothing is told as put back", () => {
    const steps = [run("a", { then: { to: "c" }, whenFailed: { to: "l" } }), say("l"), say("m", { then: { to: "c" } }), say("c")];
    const removed = removeDrawn(steps, 1);
    expect(removed).toEqual([run("a", { then: { to: "c" }, whenFailed: { to: "m" } }), say("m"), say("c")]);
    expect(resetsBetween(steps, removed)).toEqual([]);
  });
});

describe("adding and copying", () => {
  test("a new step has an id no step has, as the server names one by its place", () => {
    expect(newStepId([])).toBe("s1");
    expect(newStepId([say("s1"), say("s2")])).toBe("s3");
    expect(newStepId([say("s3"), say("x")])).toBe("s4");
    // A script, to be written or asked for: the one-line form is only what an automation made before scripts holds.
    expect(blankStep("command", [say("s1")])).toEqual({ id: "s2", kind: "command", argv: ["sh"], script: { text: "", about: "" } });
    expect(blankStep("approval", [])).toEqual({ id: "s1", kind: "approval", ask: "" });
    expect(blankStep("mission", [])).toEqual({ id: "s1", kind: "mission", goal: "" });
    expect(blankStep("agentTurn", [])).toEqual({ id: "s1", kind: "agentTurn", message: "" });
    expect(blankStep("systemEvent", [])).toEqual({ id: "s1", kind: "systemEvent", text: "" });
  });

  test("at the most a job runs, nothing is added: by a new step, by a copy, or to a lane", () => {
    const full = Array.from({ length: STEPS_MAX }, (_, n) => say(`s${n + 1}`));
    expect(STEPS_MAX).toBe(20);
    expect(addOnLine(full, 3, "systemEvent")).toEqual(full);
    expect(addOnLine(full, null, "systemEvent")).toEqual(full);
    expect(copyOnLine(full, 0)).toEqual(full);
    // One short of it, each still adds one.
    expect(addOnLine(full.slice(1), null, "systemEvent")).toHaveLength(STEPS_MAX);
    expect(copyOnLine(full.slice(1), 0)).toHaveLength(STEPS_MAX);
    const laned = [run("a", { then: { to: "c" }, whenFailed: { to: "l" } }), say("l", { then: { to: "c" } }), say("c"), ...full.slice(3)];
    expect(addToLane(laned, 0, "whenFailed", "systemEvent").steps).toEqual(laned);
    expect(addToLane(laned.slice(0, -1), 0, "whenFailed", "systemEvent").steps).toHaveLength(STEPS_MAX);
  });

  test("a new step stands where it was added, written from nothing, with an id no step has", () => {
    const steps = [run("a"), say("b")];
    expect(addOnLine(steps, 1, "approval")).toEqual([run("a"), { id: "s3", kind: "approval", ask: "" }, say("b")]);
    expect(ids(addOnLine(steps, null, "command"))).toEqual(["a", "b", "s3"]);
    expect(ids(addOnLine(steps, 0, "command"))).toEqual(["s3", "a", "b"]);
  });

  test("a copy stands right after its step with an id of its own, its name marked, its paths kept", () => {
    const steps = [run("a", { name: "Check", whenFailed: { to: "c" } }), say("b"), say("c")];
    const copied = copyOnLine(steps, 0);
    expect(ids(copied)).toEqual(["a", "s4", "b", "c"]);
    expect(copied[1]).toEqual(run("a", { id: "s4", name: "Check copy", whenFailed: { to: "c" } }));
    expect(resetsBetween(steps, copied)).toEqual([]);
    expect(copyOnLine(steps, 9)).toEqual(steps);
    expect(replaceStep(steps, 1, say("z"))).toEqual([steps[0]!, say("z"), steps[2]!]);
  });

  test("a copy of a step with steps of its own takes its words and not those steps: the run goes from the lane to the copy", () => {
    const steps = [run("a", { then: { to: "c" }, whenFailed: { to: "l" } }), say("l", { then: { to: "c" } }), say("c")];
    const copied = copyOnLine(steps, 0);
    expect(ids(copied)).toEqual(["a", "l", "s4", "c"]);
    // The copy has no path of its own into the first step's lane, and goes on to the step below.
    expect(copied[2]).toEqual({ id: "s4", kind: "command", argv: ["sh", "-lc", "run a"] });
    expect(copied[0]).toEqual(run("a", { then: { to: "s4" }, whenFailed: { to: "l" } }));
    // The lane went back into the line at the step below: now at the copy, which is the step right after it.
    expect(copied[1]).toEqual(say("l"));
    // A step of a lane is copied by nothing: it is its owner's.
    expect(copyOnLine(steps, 1)).toEqual(steps);
    // One that ended the run when done, with two steps in its place where it fails: it goes on to its copy, which
    // ends the run as it did (by being the last, which a last step does not say), and the lane still stops where it
    // stopped.
    const ends = [run("a", { then: "end", whenFailed: { to: "l" } }), say("l"), say("c")];
    expect(copyOnLine(ends, 0)).toEqual([run("a", { then: { to: "s4" }, whenFailed: { to: "l" } }), say("l"), say("c", { then: "end" }), run("a", { id: "s4" })]);
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
    expect(copyOnLine([marked, say("b")], 0)[1]).toEqual({ ...marked, id: "s3" });
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
