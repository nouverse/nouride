/**
 * A step's paths as the canvas reads and writes them (`lib/paths.ts`). Each shape is held two ways: what the page
 * draws of it, and what a run does with it, walked through the list as the daemon walks one (a step done, failed or
 * with nothing to say goes where its exit says). A change the page makes is right when the run it gives is.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationStep } from "@nouride/wire";
import { addToLane, chipExits, choiceOf, choicesFor, choosePath, groupOf, insertOnLine, moveOnLine, pathsOf, removeDrawn, ruleOf, setLaneEnd, stopsAt } from "@/modules/automations/lib/paths";
import { forward, landsAt, type ExitName, type Step } from "@/modules/automations/lib/steps";

type Exits = Pick<AutomationStep, "then" | "whenFailed" | "whenEmpty">;
const run = (id: string, exits: Exits = {}): Step => ({ id, kind: "command", argv: ["sh", "-lc", id], ...exits });
const ask = (id: string, exits: Exits = {}): Step => ({ id, kind: "agentTurn", message: id, ...exits });
const wait = (id: string, exits: Exits = {}): Step => ({ id, kind: "approval", ask: `${id}?`, ...exits });
const say = (id: string, exits: Exits = {}): Step => ({ id, kind: "systemEvent", text: id, ...exits });
const to = (id: string) => ({ to: id });

/** The steps a run passes, by id: each goes as `went` says (done unless named). */
function walk(steps: readonly Step[], went: Record<string, "failed" | "empty"> = {}): string[] {
  const passed: string[] = [];
  for (let at: number | "end" = steps.length > 0 ? 0 : "end"; at !== "end"; ) {
    const step: Step = steps[at]!;
    passed.push(step.id);
    const how = went[step.id];
    const exit: ExitName = how === "failed" ? "whenFailed" : how === "empty" ? "whenEmpty" : "then";
    at = landsAt(steps, at, exit);
    if (passed.length > 50) throw new Error("a run that does not end");
  }
  return passed;
}
const ids = (steps: readonly Step[]) => steps.map((step) => step.id);
/** A list whose paths the server would take: every one forward and to a step that is there, every id its own. */
const sound = (steps: readonly Step[]) => {
  expect(forward(steps).reset).toEqual([]);
  expect(new Set(ids(steps)).size).toBe(steps.length);
};
const line = (steps: readonly Step[], fold = true) => pathsOf(steps, fold).line.map((at) => steps[at]!.id);

/** Sum, save (which may fail), tell: the automation of the design's picture. */
const PLAIN = [ask("sum"), run("save"), say("tell")];
/** The same with "ask me first" on the save. */
const ASKS = [ask("sum"), run("save", { then: to("tell"), whenFailed: to("ok") }), wait("ok", { then: to("tell") }), say("tell")];
/** The same with other steps in its place: one that rejoins. */
const LANE = [ask("sum"), run("save", { then: to("tell"), whenFailed: to("file") }), ask("file", { then: to("tell") }), say("tell")];

describe("how a list's paths are read", () => {
  test("a list with no path of its own is its steps in a row", () => {
    const paths = pathsOf(PLAIN);
    expect(paths.line).toEqual([0, 1, 2]);
    expect(paths.rules.size).toBe(0);
    expect(paths.inside.size).toBe(0);
    expect(pathsOf([]).line).toEqual([]);
  });

  test("going on after a failure is the step's own rule, however it is written", () => {
    const next = [ask("sum"), run("save", { whenFailed: "next" }), say("tell")];
    expect(pathsOf(next).rules.get(1)).toEqual([{ exit: "whenFailed", kind: "goOn" }]);
    // Named, where the step says by name where it goes when done.
    const named = [ask("sum"), run("save", { then: to("tell"), whenFailed: to("tell") }), say("tell")];
    expect(pathsOf(named).rules.get(1)).toEqual([{ exit: "whenFailed", kind: "goOn" }]);
    expect(line(next)).toEqual(["sum", "save", "tell"]);
  });

  test("a wait only that path reaches, whose yes goes on and whose no ends the run, is drawn in its step's box", () => {
    const paths = pathsOf(ASKS);
    expect(paths.rules.get(1)).toEqual([{ exit: "whenFailed", kind: "ask", at: 2 }]);
    expect(paths.inside.get(2)).toEqual({ owner: 1, exit: "whenFailed", folded: true });
    expect(line(ASKS)).toEqual(["sum", "save", "tell"]);
    // What a run does with it: done, the wait is passed over; failed, it is asked and a yes goes on.
    expect(walk(ASKS)).toEqual(["sum", "save", "tell"]);
    expect(walk(ASKS, { save: "failed" })).toEqual(["sum", "save", "ok", "tell"]);
    expect(walk(ASKS, { save: "failed", ok: "failed" })).toEqual(["sum", "save", "ok"]);
  });

  test("over a run the same wait is a lane of one, since it is a step that went some way", () => {
    const paths = pathsOf(ASKS, false);
    expect(paths.rules.get(1)).toEqual([{ exit: "whenFailed", kind: "lane", lane: [2], ends: { back: 3 } }]);
    expect(paths.inside.get(2)?.folded).toBe(false);
  });

  test("a wait whose no leads somewhere, or whose yes goes elsewhere, is other steps in its place and not a question in a box", () => {
    const noLeads = [run("save", { then: to("tell"), whenFailed: to("ok") }), wait("ok", { then: to("tell"), whenFailed: to("tell") }), say("tell")];
    expect(pathsOf(noLeads).rules.get(0)![0]!.kind).toBe("lane");
    const yesStops = [run("save", { then: to("tell"), whenFailed: to("ok") }), wait("ok", { then: "end" }), say("tell")];
    expect(pathsOf(yesStops).rules.get(0)).toEqual([{ exit: "whenFailed", kind: "lane", lane: [1], ends: "stop" }]);
  });

  test("other steps in a step's place are a lane, which stops or goes back to the main line", () => {
    expect(pathsOf(LANE).rules.get(1)).toEqual([{ exit: "whenFailed", kind: "lane", lane: [2], ends: { back: 3 } }]);
    expect(line(LANE)).toEqual(["sum", "save", "tell"]);
    const stops = [run("check", { then: to("fine"), whenFailed: to("look") }), ask("look", { then: to("write") }), ask("write", { then: "end" }), say("fine")];
    expect(pathsOf(stops).rules.get(0)).toEqual([{ exit: "whenFailed", kind: "lane", lane: [1, 2], ends: "stop" }]);
    expect(line(stops)).toEqual(["check", "fine"]);
    expect(walk(stops, { check: "failed" })).toEqual(["check", "look", "write"]);
  });

  test("a step may hold a rule for each of its two paths", () => {
    const both = [run("check", { then: to("tell"), whenFailed: to("ok"), whenEmpty: to("tell") }), wait("ok", { then: to("tell") }), say("tell")];
    expect(pathsOf(both).rules.get(0)).toEqual([{ exit: "whenFailed", kind: "ask", at: 1 }, { exit: "whenEmpty", kind: "goOn" }]);
  });

  test("a step the main line reaches too stays on the main line, and its path is said in a chip", () => {
    // Written by hand: the last step was meant for the second's failure, and runs after the third as well.
    const both = [run("a"), run("b", { whenFailed: to("d") }), say("c"), wait("d")];
    const paths = pathsOf(both);
    expect(paths.rules.size).toBe(0);
    expect(paths.line).toEqual([0, 1, 2, 3]);
    expect(chipExits(both, 1, paths)).toEqual(["whenFailed"]);
    expect(choiceOf(both, 1, "whenFailed")).toBe("jump");
  });

  test("a step two paths lead to, and a step no path leads to, stay on the main line: nothing is hidden", () => {
    const shared = [run("a", { then: to("end1"), whenFailed: to("fix") }), run("b", { then: to("end1"), whenFailed: to("fix") }), ask("fix", { then: "end" }), say("end1")];
    // `b` is not reached when all is done, so only `a` could own the lane; and two paths reach `fix`.
    expect(pathsOf(shared).rules.size).toBe(0);
    expect(line(shared)).toEqual(["a", "b", "fix", "end1"]);
    const stray = [run("a", { then: "end" }), say("never")];
    expect(line(stray)).toEqual(["a", "never"]);
  });

  test("a path off the last step leads nowhere to go on to, and is no rule", () => {
    expect(pathsOf([run("a"), run("b", { whenFailed: "next" })]).rules.size).toBe(0);
  });
});

describe("what is still said in a chip", () => {
  test("a step's own `then` that only passes over its rule's steps is the main line, and says nothing", () => {
    const paths = pathsOf(ASKS);
    expect(chipExits(ASKS, 1, paths)).toEqual([]);
    expect(chipExits(LANE, 1, pathsOf(LANE))).toEqual([]);
    // A lane's own step: where the lane ends is drawn as its end.
    expect(chipExits(LANE, 2, pathsOf(LANE, false))).toEqual([]);
  });

  test("a jump the canvas does not draw is said: past a step of the main line, or to the end before the last", () => {
    const jumps = [run("a", { then: to("c") }), say("b"), say("c")];
    expect(chipExits(jumps, 0, pathsOf(jumps))).toEqual(["then"]);
    const ends = [run("a", { then: "end" }), say("b")];
    expect(chipExits(ends, 0, pathsOf(ends))).toEqual(["then"]);
    // The last step ending the run is what a last step does.
    const last = [run("a"), say("b", { then: "end" })];
    expect(chipExits(last, 1, pathsOf(last))).toEqual([]);
  });
});

describe("the answers a path can be given", () => {
  test("a failure can stop, go on, ask, or run other steps; silence is not asked about, and a wait's no is not asked again", () => {
    expect(choicesFor(PLAIN, 1, "whenFailed")).toEqual(["stop", "goOn", "ask", "lane"]);
    expect(choicesFor(PLAIN, 1, "whenEmpty")).toEqual(["stop", "goOn", "lane"]);
    expect(choicesFor([wait("ok"), say("tell")], 0, "whenFailed")).toEqual(["stop", "goOn", "lane"]);
  });

  test("the last step has nothing to go on to, asked or not; a question it was given elsewhere is still the answer shown", () => {
    expect(choicesFor(PLAIN, 2, "whenFailed")).toEqual(["stop", "lane"]);
    expect(choicesFor(PLAIN, 2, "whenEmpty")).toEqual(["stop", "lane"]);
    const asked = [run("a", { then: "end", whenFailed: to("w") }), wait("w", { then: "end" })];
    expect(choiceOf(asked, 0, "whenFailed")).toBe("ask");
    expect(choicesFor(asked, 0, "whenFailed")).toEqual(["stop", "lane", "ask"]);
  });

  test("a path written elsewhere that the page has no answer for is offered as it is, until it is changed", () => {
    const jump = [run("a", { whenFailed: to("c") }), say("b"), say("c")];
    expect(choicesFor(jump, 0, "whenFailed")).toEqual(["stop", "goOn", "ask", "lane", "jump"]);
    // Silence is no failure to ask about.
    expect(choicesFor(jump, 0, "whenEmpty")).toEqual(["stop", "goOn", "lane"]);
  });

  test("what a path is set to is read back as the answer it was given", () => {
    expect(choiceOf(PLAIN, 1, "whenFailed")).toBe("stop");
    expect(choiceOf(ASKS, 1, "whenFailed")).toBe("ask");
    expect(choiceOf(LANE, 1, "whenFailed")).toBe("lane");
    expect(choiceOf([run("a", { whenFailed: "end" }), say("b")], 0, "whenFailed")).toBe("stop");
  });
});

describe("a path given an answer", () => {
  test("go on: the run goes where it goes when the step is done", () => {
    const { steps, removed } = choosePath(PLAIN, 1, "whenFailed", "goOn");
    expect(steps[1]).toEqual(run("save", { whenFailed: "next" }));
    expect(removed).toBe(0);
    expect(walk(steps, { save: "failed" })).toEqual(["sum", "save", "tell"]);
    sound(steps);
  });

  test("go on, for a step that says its own next step: the same one", () => {
    const jumps = [run("a", { then: to("c") }), say("b"), say("c")];
    const { steps } = choosePath(jumps, 0, "whenFailed", "goOn");
    expect(steps[0]).toEqual(run("a", { then: to("c"), whenFailed: to("c") }));
    expect(choiceOf(steps, 0, "whenFailed")).toBe("goOn");
  });

  test("ask first: a wait is put right after the step, which then passes it over when done", () => {
    const chosen = choosePath(PLAIN, 1, "whenFailed", "ask");
    expect(ids(chosen.steps)).toEqual(["sum", "save", "s4", "tell"]);
    expect(chosen.opened).toBe("s4");
    expect(chosen.steps[1]).toEqual(run("save", { then: to("tell"), whenFailed: to("s4") }));
    expect(chosen.steps[2]).toEqual({ id: "s4", kind: "approval", ask: "", then: to("tell") });
    expect(choiceOf(chosen.steps, 1, "whenFailed")).toBe("ask");
    // The run it gives.
    expect(walk(chosen.steps)).toEqual(["sum", "save", "tell"]);
    expect(walk(chosen.steps, { save: "failed" })).toEqual(["sum", "save", "s4", "tell"]);
    expect(walk(chosen.steps, { save: "failed", s4: "failed" })).toEqual(["sum", "save", "s4"]);
    sound(chosen.steps);
  });

  test("back to a stop: the wait goes with the answer, and the step is as it was written before", () => {
    const { steps, removed } = choosePath(ASKS, 1, "whenFailed", "stop");
    expect(steps).toEqual(PLAIN);
    expect(removed).toBe(1);
  });

  test("other steps in its place: the first of a lane that goes back to the main line", () => {
    const chosen = choosePath(PLAIN, 1, "whenFailed", "lane");
    expect(ids(chosen.steps)).toEqual(["sum", "save", "s4", "tell"]);
    expect(chosen.steps[2]).toEqual({ id: "s4", kind: "agentTurn", message: "", then: to("tell") });
    expect(pathsOf(chosen.steps).rules.get(1)).toEqual([{ exit: "whenFailed", kind: "lane", lane: [2], ends: { back: 3 } }]);
    expect(walk(chosen.steps, { save: "failed" })).toEqual(["sum", "save", "s4", "tell"]);
    sound(chosen.steps);
  });

  test("one answer for another: the old answer's steps go, and are counted so the page can offer them back", () => {
    const chosen = choosePath(ASKS, 1, "whenFailed", "lane", "command");
    expect(ids(chosen.steps)).toEqual(["sum", "save", "s4", "tell"]);
    expect(chosen.steps[2]!.kind).toBe("command");
    expect(chosen.removed).toBe(1);
    const back = choosePath(chosen.steps, 1, "whenFailed", "goOn");
    expect(back.steps).toEqual([ask("sum"), run("save", { whenFailed: "next" }), say("tell")]);
    expect(back.removed).toBe(1);
  });

  test("on the last step an answer's steps are the last thing the run does", () => {
    const chosen = choosePath(PLAIN, 2, "whenFailed", "lane");
    expect(chosen.steps[2]).toEqual(say("tell", { then: "end", whenFailed: to("s4") }));
    expect(chosen.steps[3]).toEqual({ id: "s4", kind: "agentTurn", message: "" });
    expect(pathsOf(chosen.steps).rules.get(2)).toEqual([{ exit: "whenFailed", kind: "lane", lane: [3], ends: "stop" }]);
    expect(walk(chosen.steps)).toEqual(["sum", "save", "tell"]);
    expect(walk(chosen.steps, { tell: "failed" })).toEqual(["sum", "save", "tell", "s4"]);
    sound(chosen.steps);
  });

  test("a second rule on a step that has one: each path keeps its own steps", () => {
    const first = choosePath([run("check"), say("tell")], 0, "whenFailed", "ask").steps;
    const both = choosePath(first, 0, "whenEmpty", "lane").steps;
    const rules = pathsOf(both).rules.get(0)!;
    expect(rules.map((rule) => [rule.exit, rule.kind])).toEqual([["whenFailed", "ask"], ["whenEmpty", "lane"]]);
    expect(walk(both)).toEqual(["check", "tell"]);
    expect(walk(both, { check: "empty" }).at(-1)).toBe("tell");
    expect(walk(both, { check: "failed" }).length).toBe(3);
    sound(both);
    // And one taken away leaves the other.
    const one = choosePath(both, 0, "whenFailed", "stop").steps;
    expect(pathsOf(one).rules.get(0)!.map((rule) => [rule.exit, rule.kind])).toEqual([["whenEmpty", "lane"]]);
    sound(one);
  });

  test("the answer it already has changes nothing", () => {
    expect(choosePath(ASKS, 1, "whenFailed", "ask")).toEqual({ steps: ASKS, removed: 0 });
  });
});

describe("a lane", () => {
  test("its end is set: a stop, or back to where its step goes on", () => {
    const stops = setLaneEnd(LANE, 1, "whenFailed", "stop");
    expect(stops[2]).toEqual(ask("file", { then: "end" }));
    expect(pathsOf(stops).rules.get(1)).toEqual([{ exit: "whenFailed", kind: "lane", lane: [2], ends: "stop" }]);
    expect(walk(stops, { save: "failed" })).toEqual(["sum", "save", "file"]);
    expect(setLaneEnd(stops, 1, "whenFailed", "back")).toEqual(LANE);
  });

  test("a step added at its end takes the lane's ending, and the step before it goes on to it", () => {
    const chosen = addToLane(LANE, 1, "whenFailed", "systemEvent");
    expect(ids(chosen.steps)).toEqual(["sum", "save", "file", "s5", "tell"]);
    expect(chosen.opened).toBe("s5");
    expect(pathsOf(chosen.steps).rules.get(1)).toEqual([{ exit: "whenFailed", kind: "lane", lane: [2, 3], ends: { back: 4 } }]);
    expect(walk(chosen.steps, { save: "failed" })).toEqual(["sum", "save", "file", "s5", "tell"]);
    sound(chosen.steps);
  });
});

describe("a step put on the main line", () => {
  test("between two steps of a plain list it is simply the next one", () => {
    const steps = insertOnLine(PLAIN, 2, say("new"));
    expect(steps).toEqual([ask("sum"), run("save"), say("new"), say("tell")]);
  });

  test("below a step with a rule: the step, and its rule's way back, go on to the new step", () => {
    const steps = insertOnLine(ASKS, 3, say("new"));
    expect(ids(steps)).toEqual(["sum", "save", "ok", "new", "tell"]);
    expect(line(steps)).toEqual(["sum", "save", "new", "tell"]);
    expect(walk(steps)).toEqual(["sum", "save", "new", "tell"]);
    expect(walk(steps, { save: "failed" })).toEqual(["sum", "save", "ok", "new", "tell"]);
    expect(choiceOf(steps, 1, "whenFailed")).toBe("ask");
    sound(steps);
  });

  test("at the end, below a last step with a lane that stops: the step goes on, and the lane still stops", () => {
    const last = choosePath(PLAIN, 2, "whenFailed", "lane").steps;
    const steps = insertOnLine(last, null, say("new"));
    expect(line(steps)).toEqual(["sum", "save", "tell", "new"]);
    expect(walk(steps)).toEqual(["sum", "save", "tell", "new"]);
    expect(walk(steps, { tell: "failed" })).toEqual(["sum", "save", "tell", "s4"]);
    sound(steps);
  });

  test("at the start", () => {
    expect(ids(insertOnLine(ASKS, 0, say("new")))).toEqual(["new", "sum", "save", "ok", "tell"]);
  });
});

describe("a step taken out", () => {
  test("one on the main line goes with the steps of its rules, and the line closes over it", () => {
    const steps = removeDrawn(ASKS, 1);
    expect(steps).toEqual([ask("sum"), say("tell")]);
    expect(groupOf(ASKS, 1)).toEqual([1, 2]);
  });

  test("the step below one with a rule: the rule goes on to what is drawn below that", () => {
    const longer = [...ASKS, say("after")];
    const steps = removeDrawn(longer, 3);
    expect(ids(steps)).toEqual(["sum", "save", "ok", "after"]);
    expect(walk(steps, { save: "failed" })).toEqual(["sum", "save", "ok", "after"]);
    expect(choiceOf(steps, 1, "whenFailed")).toBe("ask");
    sound(steps);
  });

  test("a lane's only step takes the lane with it, and the path is back to a stop", () => {
    expect(removeDrawn(LANE, 2)).toEqual(PLAIN);
  });

  test("the first of a lane's steps: the path leads to the second", () => {
    const two = addToLane(LANE, 1, "whenFailed", "systemEvent").steps;
    const steps = removeDrawn(two, 2);
    expect(ids(steps)).toEqual(["sum", "save", "s5", "tell"]);
    expect(walk(steps, { save: "failed" })).toEqual(["sum", "save", "s5", "tell"]);
    sound(steps);
  });

  test("the last of a lane's steps: the one before it takes the lane's ending", () => {
    const two = addToLane(setLaneEnd(LANE, 1, "whenFailed", "stop"), 1, "whenFailed", "systemEvent").steps;
    expect(walk(two, { save: "failed" })).toEqual(["sum", "save", "file", "s5"]);
    const steps = removeDrawn(two, 3);
    expect(ids(steps)).toEqual(["sum", "save", "file", "tell"]);
    expect(walk(steps, { save: "failed" })).toEqual(["sum", "save", "file"]);
    sound(steps);
  });
});

describe("a step of the main line moved", () => {
  test("a plain step moves as a step of a list does", () => {
    expect(ids(moveOnLine(PLAIN, 0, 1))).toEqual(["save", "sum", "tell"]);
    expect(ids(moveOnLine(PLAIN, 2, 0))).toEqual(["tell", "sum", "save"]);
  });

  test("a step with a rule moves with its rule's steps, and the run through it is the same in its new place", () => {
    const longer = [...ASKS, say("after")];
    const steps = moveOnLine(longer, 1, 2);
    expect(line(steps)).toEqual(["sum", "tell", "save", "after"]);
    expect(walk(steps)).toEqual(["sum", "tell", "save", "after"]);
    expect(walk(steps, { save: "failed" })).toEqual(["sum", "tell", "save", "ok", "after"]);
    expect(choiceOf(steps, steps.findIndex((step) => step.id === "save"), "whenFailed")).toBe("ask");
    sound(steps);
  });

  test("a path that named a step by hand still names it after that step moves, where it is still ahead; behind, it is put back", () => {
    // Written elsewhere: the first step's failure leads to a step the main line reaches too.
    const hand = [run("a", { whenFailed: to("c") }), say("b"), wait("c"), say("d")];
    const up = moveOnLine(hand, 2, 1);
    expect(ids(up)).toEqual(["a", "c", "b", "d"]);
    expect(up[0]!.whenFailed).toEqual(to("c"));
    const top = moveOnLine(up, 1, 0);
    expect(ids(top)).toEqual(["c", "a", "b", "d"]);
    expect(top[1]!.whenFailed).toBeUndefined();
    sound(top);
  });

  test("moved to the end, its rule's way back becomes the run's end", () => {
    const steps = moveOnLine(ASKS, 1, 2);
    expect(line(steps)).toEqual(["sum", "tell", "save"]);
    expect(walk(steps, { save: "failed" })).toEqual(["sum", "tell", "save", "ok"]);
    sound(steps);
  });

  test("a step moved over one with a rule lands outside that rule's steps", () => {
    const steps = moveOnLine(ASKS, 0, 1);
    expect(line(steps)).toEqual(["save", "sum", "tell"]);
    expect(walk(steps, { save: "failed" })).toEqual(["save", "ok", "sum", "tell"]);
    expect(ruleOf(pathsOf(steps), 0, "whenFailed")?.kind).toBe("ask");
    sound(steps);
  });
});

/** Check, and when it fails: look, then write, then back to tell. The lane has two steps of its own. */
const TWO = [run("check", { then: to("tell"), whenFailed: to("look") }), ask("look"), ask("write", { then: to("tell") }), say("tell"), say("bye")];

describe("a step of a lane answers for itself", () => {
  test("it is offered a stop or going on, and no steps of its own: a lane of a lane is not drawn", () => {
    expect(choicesFor(TWO, 1, "whenFailed")).toEqual(["stop", "goOn"]);
    expect(choicesFor(TWO, 1, "whenEmpty")).toEqual(["stop", "goOn"]);
    // The step that owns the lane keeps all four.
    expect(choicesFor(TWO, 0, "whenFailed")).toEqual(["stop", "goOn", "ask", "lane"]);
    // The last step of a lane that stops has nothing to go on to.
    const stops = setLaneEnd(TWO, 0, "whenFailed", "stop");
    expect(choicesFor(stops, 2, "whenFailed")).toEqual(["stop"]);
  });

  test("unless told otherwise it stops there: said of every step that can fail, and of no message, which cannot", () => {
    const paths = pathsOf(TWO);
    expect(TWO.map((_step, at) => stopsAt(TWO, at, paths))).toEqual([[], ["whenFailed"], ["whenFailed"], [], []]);
    const asked = pathsOf(ASKS);
    // A question in its box is the answer; the plain step before it stops.
    expect(ASKS.map((_step, at) => stopsAt(ASKS, at, asked))).toEqual([["whenFailed"], [], ["whenFailed"], []]);
  });

  test("go on, in the middle of a lane: the lane is still a lane, the step says so in its box, and a failed run goes on down it", () => {
    const chosen = choosePath(TWO, 1, "whenFailed", "goOn").steps;
    sound(chosen);
    const paths = pathsOf(chosen);
    expect(paths.rules.get(0)).toEqual([{ exit: "whenFailed", kind: "lane", lane: [1, 2], ends: { back: 3 } }]);
    expect(paths.rules.get(1)).toEqual([{ exit: "whenFailed", kind: "goOn" }]);
    expect(choiceOf(chosen, 1, "whenFailed", paths)).toBe("goOn");
    expect(chipExits(chosen, 1, paths)).toEqual([]);
    expect(stopsAt(chosen, 1, paths)).toEqual([]);
    expect(walk(chosen, { check: "failed", look: "failed" })).toEqual(["check", "look", "write", "tell", "bye"]);
    // And back to a stop: as it was written before.
    expect(choosePath(chosen, 1, "whenFailed", "stop").steps).toEqual(TWO);
  });

  test("go on, at a lane's end: back into the main line where the lane goes back", () => {
    const chosen = choosePath(TWO, 2, "whenFailed", "goOn").steps;
    sound(chosen);
    expect(pathsOf(chosen).rules.get(2)).toEqual([{ exit: "whenFailed", kind: "goOn" }]);
    expect(pathsOf(chosen).rules.get(0)).toEqual([{ exit: "whenFailed", kind: "lane", lane: [1, 2], ends: { back: 3 } }]);
    expect(walk(chosen, { check: "failed", write: "failed" })).toEqual(["check", "look", "write", "tell", "bye"]);
    expect(walk(TWO, { check: "failed", write: "failed" })).toEqual(["check", "look", "write"]);
  });

  /**
   * The same check with a second lane, for silence, between its first lane and the step both go back to. A lane's last
   * step then names the step it goes back to (the next step in the list is the other lane's), and so does its going on:
   * the shape in which a path left pointing where it used to go is a jump, or runs the other lane's step.
   */
  const DUO = [run("check", { then: to("tell"), whenFailed: to("look"), whenEmpty: to("quiet") }), ask("look"), ask("write", { then: to("tell") }), say("quiet", { then: to("tell") }), say("tell"), say("bye")];
  const at = (steps: readonly Step[], id: string) => ids(steps).indexOf(id);
  const goesOn = (steps: readonly Step[], id: string) => expect([pathsOf(steps).rules.get(at(steps, id)), chipExits(steps, at(steps, id), pathsOf(steps))]).toEqual([[{ exit: "whenFailed", kind: "goOn" }], []]);

  test("the two lanes are read, and going on at the first one's end names the step it goes back to", () => {
    expect(pathsOf(DUO).rules.get(0)).toEqual([{ exit: "whenFailed", kind: "lane", lane: [1, 2], ends: { back: 4 } }, { exit: "whenEmpty", kind: "lane", lane: [3], ends: { back: 4 } }]);
    const last = choosePath(DUO, 2, "whenFailed", "goOn").steps;
    sound(last);
    expect(last[2]).toMatchObject({ then: to("tell"), whenFailed: to("tell") });
    goesOn(last, "write");
  });

  test("a step added after one that goes on: it goes on to the new step, not past it", () => {
    const added = addToLane(choosePath(DUO, 2, "whenFailed", "goOn").steps, 0, "whenFailed", "systemEvent").steps;
    sound(added);
    goesOn(added, "write");
    const made = added[3]!.id;
    expect(walk(added, { check: "failed", write: "failed" })).toEqual(["check", "look", "write", made, "tell", "bye"]);
  });

  test("its lane set to stop: there is nothing left to go on to, and no jump is left behind", () => {
    const stopped = setLaneEnd(choosePath(DUO, 2, "whenFailed", "goOn").steps, 0, "whenFailed", "stop");
    sound(stopped);
    expect(stopped[2]!.whenFailed).toBeUndefined();
    expect(chipExits(stopped, 2, pathsOf(stopped))).toEqual([]);
    expect(walk(stopped, { check: "failed", write: "failed" })).toEqual(["check", "look", "write"]);
  });

  test("the step after one that goes on, taken out: it goes on to what the lane goes back to, never into the other lane", () => {
    const middle = choosePath(DUO, 1, "whenFailed", "goOn").steps;
    expect(walk(middle, { check: "failed", look: "failed" })).toEqual(["check", "look", "write", "tell", "bye"]);
    const without = removeDrawn(middle, 2);
    sound(without);
    goesOn(without, "look");
    expect(walk(without, { check: "failed", look: "failed" })).toEqual(["check", "look", "tell", "bye"]);
  });

  test("the step its lane goes back to, taken out: going on goes where the lane goes now", () => {
    const without = removeDrawn(choosePath(DUO, 2, "whenFailed", "goOn").steps, 4);
    sound(without);
    goesOn(without, "write");
    expect(walk(without, { check: "failed", write: "failed" })).toEqual(["check", "look", "write", "bye"]);
  });

  test("its step moved down the line, with its lanes: going on goes back in where the lane does now; at the end there is nothing to go on to", () => {
    const last = choosePath(DUO, 2, "whenFailed", "goOn").steps;
    const down = moveOnLine(last, 0, 1);
    sound(down);
    expect(line(down)).toEqual(["tell", "check", "bye"]);
    goesOn(down, "write");
    expect(walk(down, { check: "failed", write: "failed" })).toEqual(["tell", "check", "look", "write", "bye"]);
    const end = moveOnLine(last, 0, 2);
    sound(end);
    expect(line(end)).toEqual(["tell", "bye", "check"]);
    expect(chipExits(end, at(end, "write"), pathsOf(end))).toEqual([]);
    expect(walk(end, { check: "failed", write: "failed" })).toEqual(["tell", "bye", "check", "look", "write"]);
  });
});
