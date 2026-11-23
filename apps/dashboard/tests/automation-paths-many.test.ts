/**
 * The canvas's own operations, one after another in orders nobody wrote down: whatever a person does on the page with
 * an automation the page made, the steps still run in the order they are drawn, top to bottom, with no jump the canvas
 * has no drawing for and no step the run cannot reach.
 *
 * Found on a live box: a step with steps in its place, dragged to the top of the line, kept going on to the step that
 * used to follow it. Every box above that one was drawn and never run, and the canvas said so only in a small label
 * ("Once done → step 5"). Each operation had its own tests, each on the shapes its author thought of; this walks
 * the shapes that come of using them together.
 */

import { describe, expect, test } from "bun:test";
import { addOnLine, addToLane, chipExits, choicesFor, choosePath, copyOnLine, laneBacks, moveOnLine, pathsOf, removeDrawn, setLaneEnd, PATH_EXITS, type Paths, type PathExit } from "@/modules/automations/lib/paths";
import { STEPS_MAX, exitsOf, forward, landsAt, type Step, type StepKind } from "@/modules/automations/lib/steps";

/** A small generator of its own, so a run that fails is the same run again: mulberry32. */
function dice(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return (below) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
  };
}

const KINDS: StepKind[] = ["agentTurn", "command", "systemEvent", "mission", "approval", "parallel"];
const ids = (steps: readonly Step[]) => steps.map((step) => step.id);
const lineOf = (steps: readonly Step[], paths: Paths) => paths.line.map((at) => steps[at]!.id);
/** Each step that has a lane, with the lane's steps and where it ends, by id. */
const lanesOf = (steps: readonly Step[], paths: Paths) =>
  [...paths.rules].flatMap(([owner, rules]) =>
    rules.flatMap((rule) => (rule.kind === "lane" ? [{ owner: steps[owner]!.id, exit: rule.exit, lane: rule.lane.map((at) => steps[at]!.id), ends: rule.ends === "stop" ? "stop" : steps[rule.ends.back]!.id }] : [])),
  );

/** What is wrong with a list the page made, in words; none when it is as drawn. */
function wrong(steps: readonly Step[]): string[] {
  const said: string[] = [];
  if (forward(steps).reset.length > 0) said.push(`a path points back or nowhere: ${JSON.stringify(forward(steps).reset)}`);
  if (new Set(ids(steps)).size !== steps.length) said.push("two steps share an id");
  const paths = pathsOf(steps, false);
  steps.forEach((step, at) => {
    const chips = chipExits(steps, at, paths);
    if (chips.length > 0) said.push(`${step.id} has a jump the canvas does not draw: ${chips.join(", ")} -> ${chips.map((exit) => landsAt(steps, at, exit)).join(", ")}`);
  });
  // The run, every step done, passes the main line as it is drawn: each box, top to bottom.
  const passed: string[] = [];
  for (let at: number | "end" = steps.length > 0 ? 0 : "end"; at !== "end" && passed.length <= steps.length; at = landsAt(steps, at, "then")) passed.push(steps[at]!.id);
  const drawn = lineOf(steps, paths);
  if (JSON.stringify(passed) !== JSON.stringify(drawn)) said.push(`drawn ${drawn.join(" ")} but a run passes ${passed.join(" ")}`);
  return said;
}

interface Did {
  what: string;
  steps: Step[];
}

/** One thing a person does on the page, picked by the dice among what the page offers on this list. */
function act(steps: readonly Step[], roll: (below: number) => number): Did {
  const paths = pathsOf(steps, false);
  const folded = pathsOf(steps);
  const line = paths.line;
  const pick = <T>(of: readonly T[]): T => of[roll(of.length)]!;
  const laned = lanesOf(steps, paths);
  const choices: (() => Did | null)[] = [
    () => (steps.length >= STEPS_MAX ? null : ((before) => ({ what: `add before ${before === null ? "the end" : steps[before]!.id}`, steps: addOnLine(steps, before, pick(KINDS)) }))(roll(line.length + 1) === line.length ? null : pick(line))),
    () => {
      if (line.length < 2) return null;
      const [from, to] = [roll(line.length), roll(line.length)];
      return from === to ? null : { what: `move ${steps[line[from]!]!.id} to place ${to + 1}`, steps: moveOnLine(steps, line[from]!, to) };
    },
    // A box that is drawn: a question asked in a step's own box is no box, and goes with its answer.
    () => (steps.length < 2 ? null : ((at) => ({ what: `remove ${steps[at]!.id}`, steps: removeDrawn(steps, at) }))(pick(steps.map((_step, at) => at).filter((at) => !folded.inside.get(at)?.folded)))),
    () => (steps.length >= STEPS_MAX || line.length === 0 ? null : ((at) => ({ what: `duplicate ${steps[at]!.id}`, steps: copyOnLine(steps, at) }))(pick(line))),
    () => {
      // A path of a step drawn as a box, given one of the answers the page offers for it.
      const drawn = steps.map((_step, at) => at).filter((at) => !folded.inside.get(at)?.folded);
      if (drawn.length === 0 || steps.length >= STEPS_MAX - 1) return null;
      const at = pick(drawn);
      const exits: PathExit[] = PATH_EXITS.filter((one) => exitsOf(steps[at]!).includes(one));
      if (exits.length === 0) return null;
      const exit = pick(exits);
      const choice = pick(choicesFor(steps, at, exit, folded).filter((one) => one !== "jump"));
      return { what: `${steps[at]!.id} ${exit}: ${choice}`, steps: choosePath(steps, at, exit, choice as never).steps };
    },
    () => {
      if (laned.length === 0 || steps.length >= STEPS_MAX) return null;
      const lane = pick(laned);
      return { what: `add to the lane of ${lane.owner}`, steps: addToLane(steps, ids(steps).indexOf(lane.owner), lane.exit, pick(KINDS.filter((kind) => kind !== "approval"))).steps };
    },
    () => {
      if (laned.length === 0) return null;
      const lane = pick(laned);
      const owner = ids(steps).indexOf(lane.owner);
      const backs = laneBacks(steps, owner, lane.lane.map((id) => ids(steps).indexOf(id)));
      const ends = pick<"stop" | { to: string }>(["stop", ...backs.map((at) => ({ to: steps[at]!.id }))]);
      return { what: `the lane of ${lane.owner} ends ${typeof ends === "string" ? ends : `back at ${ends.to}`}`, steps: setLaneEnd(steps, owner, lane.exit, ends) };
    },
  ];
  for (let tries = 0; tries < 20; tries += 1) {
    const did = pick(choices)();
    if (did) return did;
  }
  return { what: "nothing", steps: [...steps] };
}

/**
 * What became of the lanes: each step that ran in another's place still does, for the same step and the same path,
 * unless that step was given another answer, or went. A list can run as it is drawn and still have turned a lane's
 * step into a step of the main line: the step after one with a question deleted, and the question became a step.
 */
function lanesLost(was: readonly Step[], now: readonly Step[], what: string): string[] {
  const after = lanesOf(now, pathsOf(now, false));
  const there = new Set(ids(now));
  return lanesOf(was, pathsOf(was, false)).flatMap((lane) => {
    // Its step answered anew, or gone: its lane may go with it.
    if (!there.has(lane.owner) || what.startsWith(`${lane.owner} ${lane.exit}:`)) return [];
    const left = lane.lane.filter((id) => there.has(id));
    const has = after.find((one) => one.owner === lane.owner && one.exit === lane.exit)?.lane ?? [];
    return left.every((id) => has.includes(id)) ? [] : [`${lane.owner}'s steps for ${lane.exit} were ${lane.lane.join(" ")}, and are ${has.join(" ") || "no lane"}`];
  });
}

/** A walk: a few steps to begin with, then things done one after another. It stops at the first that leaves the list wrong. */
function walked(seed: number, first: number, things: number): { steps: Step[]; failed: string | null; roll: (below: number) => number } {
  const roll = dice(seed);
  let steps: Step[] = [];
  for (let n = 0; n < first; n += 1) steps = addOnLine(steps, null, KINDS[roll(KINDS.length)]!);
  const done: string[] = [];
  for (let n = 0; n < things; n += 1) {
    const did = act(steps, roll);
    done.push(did.what);
    const said = [...wrong(did.steps), ...lanesLost(steps, did.steps, did.what)];
    if (said.length > 0) return { steps, roll, failed: `seed ${seed}, after: ${done.slice(-5).join(" | ")}\n  ${said.join("\n  ")}\n  was ${JSON.stringify(steps)}\n  now ${JSON.stringify(did.steps)}` };
    steps = did.steps;
  }
  return { steps, roll, failed: null };
}

describe("the page's operations, one after another", () => {
  test("a thousand walks of twenty-five things done: the steps always run as they are drawn", () => {
    const failed: string[] = [];
    for (let seed = 1; seed <= 1000 && failed.length < 4; seed += 1) {
      const walk = walked(seed, 3, 25);
      if (walk.failed) failed.push(walk.failed);
    }
    expect(failed).toEqual([]);
  });

  test("a step moved keeps its lane, and a lane keeps where it ends: at the step it named while that step is still below, else where its own step goes on", () => {
    const failed: string[] = [];
    let moves = 0;
    for (let seed = 1; seed <= 1000 && failed.length < 4; seed += 1) {
      const { steps, roll, failed: before } = walked(seed * 7919, 4, 12);
      if (before) {
        failed.push(before);
        continue;
      }
      const paths = pathsOf(steps, false);
      const line = lineOf(steps, paths);
      if (line.length < 2) continue;
      const [from, to] = [roll(line.length), roll(line.length)];
      if (from === to) continue;
      moves += 1;
      const moved = moveOnLine(steps, paths.line[from]!, to);
      const after = pathsOf(moved, false);
      const want = line.filter((id) => id !== line[from]);
      want.splice(to, 0, line[from]!);
      const problems = wrong(moved);
      if (JSON.stringify(lineOf(moved, after)) !== JSON.stringify(want)) problems.push(`the line is ${lineOf(moved, after).join(" ")}, not ${want.join(" ")}`);
      // Each lane with its own steps still, and its end: a stop stays a stop; a step it named is still its end while
      // that step is below its owner; else it goes back where its owner goes on, or stops with nothing below.
      const next = (id: string) => want[want.indexOf(id) + 1] ?? "stop";
      const expected = lanesOf(steps, paths).map((lane) => {
        const wasNext = line[line.indexOf(lane.owner) + 1] ?? "stop";
        const stays = lane.ends !== "stop" && lane.ends !== wasNext && want.indexOf(lane.ends) > want.indexOf(lane.owner);
        return { ...lane, ends: lane.ends === "stop" ? "stop" : stays ? lane.ends : next(lane.owner) };
      });
      const byOwner = (a: { owner: string; exit: string }, b: { owner: string; exit: string }) => `${a.owner}${a.exit}`.localeCompare(`${b.owner}${b.exit}`);
      if (JSON.stringify(lanesOf(moved, after).sort(byOwner)) !== JSON.stringify(expected.sort(byOwner))) problems.push(`lanes ${JSON.stringify(lanesOf(moved, after).sort(byOwner))}\n   not ${JSON.stringify(expected.sort(byOwner))}`);
      if (problems.length > 0) failed.push(`seed ${seed}: move ${line[from]} to place ${to + 1}\n  ${problems.join("\n  ")}\n  was ${JSON.stringify(steps)}\n  now ${JSON.stringify(moved)}`);
    }
    expect(failed).toEqual([]);
    // The walks did reach a move, most of them.
    expect(moves).toBeGreaterThan(500);
  });
});
