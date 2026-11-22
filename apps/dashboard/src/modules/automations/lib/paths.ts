/**
 * A step's paths as the canvas says and draws them. Pure (`tests/automation-paths.test.ts`): nothing is stored for the
 * drawing, and every shape the page writes is one the daemon already runs.
 *
 * A path that leaves the main line was drawn as a chip, "If it fails → step 4", and its step stood in the list as if it
 * ran after the one above it. A person asked "and if it fails, then what?", and the page answered with a jump. So a
 * path is read as one of four answers:
 *
 * - **stop**: what a step does unless told otherwise. Nothing is drawn.
 * - **go on**: the run goes where it goes when the step is done. One line in the step's own box.
 * - **ask**: a wait for a person's OK that only this path reaches, whose yes goes on and whose no ends the run. Drawn in
 *   the step's own box, with the question and both answers; the wait is no box of its own.
 * - **other steps** in its place: a lane at the step's side, which ends in one of two marks, back into the main line or
 *   a stop.
 *
 * Anything else an automation holds (a jump between two steps of the main line, a step two paths reach, a step no path
 * reaches) stays on the main line at its place, with its path said in a chip as before. An automation written by hand
 * can hold any of them, and the page hides nothing it holds.
 *
 * The page writes a rule's steps right after the step that owns them, and sets that step's own `then` to the step that
 * followed: exits only point forward, so this is the one shape in which the main line never falls into a side step.
 */

import { DEFAULT_EXIT, STEPS_MAX, blankStep, forward, landsAt, newStepId, withId, type ExitName, type Step, type StepKind } from "./steps";

/** A path that can leave the main line: on a failure (a no, for a wait), or with nothing to say. */
export type PathExit = "whenFailed" | "whenEmpty";
export const PATH_EXITS: readonly PathExit[] = ["whenFailed", "whenEmpty"];

export type Rule =
  | { exit: PathExit; kind: "goOn" }
  /** `at`: the wait for a person this path leads to, by its place in the list. */
  | { exit: PathExit; kind: "ask"; at: number }
  /** `lane`: the steps that run in its place, in order. `ends`: the run stops after them, or goes back to a step of the main line. */
  | { exit: PathExit; kind: "lane"; lane: number[]; ends: "stop" | { back: number } };

export interface Paths {
  /** The steps drawn down the main line, by their place in the list, in order. */
  line: number[];
  /** Each step's own rules, by its place. */
  rules: ReadonlyMap<number, Rule[]>;
  /** The steps that are part of a rule: the step that owns each, and whether it is drawn in that step's box. */
  inside: ReadonlyMap<number, { owner: number; exit: PathExit; folded: boolean }>;
}

/** Every way a step is reached: the step it is reached from and the exit taken, a default `then` among them. */
function reachedBy(steps: readonly Step[]): Map<number, { from: number; exit: ExitName }[]> {
  const reached = new Map<number, { from: number; exit: ExitName }[]>();
  steps.forEach((_step, from) => {
    for (const exit of ["then", "whenFailed", "whenEmpty"] as const) {
      const to = landsAt(steps, from, exit);
      if (to !== "end") reached.set(to, [...(reached.get(to) ?? []), { from, exit }]);
    }
  });
  return reached;
}

/** The steps a run passes when every step is done: the first, then where each one's `then` leads. */
function doneLine(steps: readonly Step[]): Set<number> {
  const line = new Set<number>();
  for (let at: number | "end" = steps.length > 0 ? 0 : "end"; at !== "end" && !line.has(at); at = landsAt(steps, at, "then")) line.add(at);
  return line;
}

/**
 * How a list's paths are read. `fold`: a wait a path leads to is drawn in its step's box. Over a run it is not, since
 * the wait is then a step that went some way and may be waiting for an answer: it is a lane of one.
 */
export function pathsOf(steps: readonly Step[], fold = true): Paths {
  const main = doneLine(steps);
  const reached = reachedBy(steps);
  const only = (at: number, from: number, exit: ExitName): boolean => {
    const ways = reached.get(at) ?? [];
    return ways.length === 1 && ways[0]!.from === from && ways[0]!.exit === exit;
  };
  const rules = new Map<number, Rule[]>();
  const inside = new Map<number, { owner: number; exit: PathExit; folded: boolean }>();

  for (const owner of main) {
    const done = landsAt(steps, owner, "then");
    for (const exit of PATH_EXITS) {
      if (steps[owner]![exit] === undefined) continue;
      const to = landsAt(steps, owner, exit);
      if (to === "end") continue;
      if (to === done) {
        rules.set(owner, [...(rules.get(owner) ?? []), { exit, kind: "goOn" }]);
        continue;
      }
      // Other steps in its place: reached by this path alone, each after the first by the one before it alone, and none
      // of them a step the run passes anyway.
      if (main.has(to) || !only(to, owner, exit)) continue;
      const lane = [to];
      let next = landsAt(steps, to, "then");
      while (next !== "end" && !main.has(next) && only(next, lane.at(-1)!, "then") && !lane.includes(next)) {
        lane.push(next);
        next = landsAt(steps, next, "then");
      }
      // A lane that runs into a step it may not hold (one two paths reach) is no lane: its steps stay on the main line.
      if (next !== "end" && !main.has(next)) continue;
      const ends = next === "end" ? ("stop" as const) : { back: next };
      const wait = steps[to]!;
      const asks = lane.length === 1 && wait.kind === "approval" && next === done && landsAt(steps, to, "whenFailed") === "end";
      rules.set(owner, [...(rules.get(owner) ?? []), asks && fold ? { exit, kind: "ask", at: to } : { exit, kind: "lane", lane, ends }]);
      for (const at of lane) inside.set(at, { owner, exit, folded: asks && fold });
    }
  }
  return { line: steps.map((_step, at) => at).filter((at) => !inside.has(at)), rules, inside };
}

/** A step's rule for one of its paths, where it has one. */
export const ruleOf = (paths: Paths, at: number, exit: PathExit): Rule | undefined => paths.rules.get(at)?.find((rule) => rule.exit === exit);

/** The step drawn after one on the main line, or none after the last. */
function nextOnLine(paths: Paths, at: number): number | null {
  const place = paths.line.indexOf(at);
  return place >= 0 ? (paths.line[place + 1] ?? null) : null;
}

/**
 * The paths still said in a chip under a step's box: those no rule covers, and no `then` that only says what the canvas
 * draws already (on to the step drawn next, the end after the last one, a lane's own end).
 */
export function chipExits(steps: readonly Step[], at: number, paths: Paths): ExitName[] {
  const step = steps[at]!;
  const within = paths.inside.get(at);
  return (["then", "whenFailed", "whenEmpty"] as const).filter((exit) => {
    const go = step[exit];
    if (go === undefined || go === DEFAULT_EXIT[exit]) return false;
    if (exit !== "then") return ruleOf(paths, at, exit) === undefined && landsAt(steps, at, exit) !== "end";
    // A step of a lane: its `then` is the lane's next step or the lane's end, both drawn.
    if (within) return false;
    const to = landsAt(steps, at, "then");
    return to === "end" ? nextOnLine(paths, at) !== null : to !== nextOnLine(paths, at);
  });
}

/** The four answers, as the panel offers them. `jump` is one the page did not write: a path to a step of the main line. */
export type Choice = "stop" | "goOn" | "ask" | "lane" | "jump";

/** What a path is set to now. */
export function choiceOf(steps: readonly Step[], at: number, exit: PathExit, paths: Paths = pathsOf(steps)): Choice {
  const rule = ruleOf(paths, at, exit);
  if (rule) return rule.kind;
  return steps[at]![exit] === undefined || landsAt(steps, at, exit) === "end" ? "stop" : "jump";
}

/**
 * The answers a path can be given from the page. A wait says no and is not asked again, silence is no failure to ask
 * about, and a step with nothing after it has nothing to go on to, asked or not. What the step holds now is always
 * among them, whoever wrote it: an answer the page would not offer is still the one shown as chosen.
 */
export function choicesFor(steps: readonly Step[], at: number, exit: PathExit, paths: Paths = pathsOf(steps)): Choice[] {
  const goesOn = landsAt(steps, at, "then") !== "end";
  const asks = goesOn && exit === "whenFailed" && steps[at]!.kind !== "approval";
  const offered: Choice[] = ["stop", ...(goesOn ? (["goOn"] as const) : []), ...(asks ? (["ask"] as const) : []), "lane"];
  const now = choiceOf(steps, at, exit, paths);
  return offered.includes(now) ? offered : [...offered, now];
}

/** The steps a rule holds, by their place. */
const held = (rule: Rule | undefined): number[] => (rule?.kind === "ask" ? [rule.at] : rule?.kind === "lane" ? rule.lane : []);

/** A step with one exit set, or taken off where it is what the step does anyway. */
function withExit(step: Step, exit: ExitName, go: Step[ExitName]): Step {
  const { [exit]: _was, ...rest } = step;
  return (go === undefined || go === DEFAULT_EXIT[exit] ? rest : { ...rest, [exit]: go }) as Step;
}

/**
 * The list with a step's `then` said in the fewest words: left out where the step it names is the one right after it,
 * which is what a step with no `then` does. Written out again by `ownThen` when a rule's steps go in between.
 */
function tidyThen(steps: Step[], at: number): Step[] {
  const go = steps[at]?.then;
  if (typeof go !== "object" || steps[at + 1]?.id !== go.to) return steps;
  return steps.map((step, index) => (index === at ? withExit(step, "then", undefined) : step));
}

/**
 * "Go on anyway" in the words that still mean it when a step is put in between later: where the step now says nothing
 * of where it goes when done, and the path names the step right after it, the path is "next". Only for a path the
 * page just set to go on: one written by hand to name a step means that step, wherever it moves.
 */
function goesOnNext(steps: Step[], at: number, exit: PathExit): Step[] {
  const step = steps[at];
  const go = step?.[exit];
  if (!step || step.then !== undefined || typeof go !== "object" || steps[at + 1]?.id !== go.to) return steps;
  return steps.map((one, index) => (index === at ? withExit(one, exit, "next") : one));
}

/**
 * Where a step goes when done, said so that steps put in right after it are passed over: the step that follows it now
 * by name, or the end. One that says its own is left as it is.
 */
function ownThen(steps: readonly Step[], at: number): Step["then"] {
  const step = steps[at]!;
  if (step.then !== undefined) return step.then;
  const to = landsAt(steps, at, "then");
  return to === "end" ? "end" : { to: steps[to]!.id };
}

export interface Chosen {
  steps: Step[];
  /** A step the choice made, to be opened and written. */
  opened?: string;
  /** How many steps the choice took out: said, with a way back. */
  removed: number;
}

/**
 * A path given one of the four answers. The steps of the answer it had go with it (a wait, a lane), and the new
 * answer's steps are put right after the step, which then says by name where it goes when done.
 */
export function choosePath(steps: readonly Step[], at: number, exit: PathExit, choice: Exclude<Choice, "jump">, lane: StepKind = "agentTurn"): Chosen {
  const step = steps[at];
  if (!step) return { steps: [...steps], removed: 0 };
  const paths = pathsOf(steps);
  if (choiceOf(steps, at, exit, paths) === choice) return { steps: [...steps], removed: 0 };
  const gone = new Set(held(ruleOf(paths, at, exit)));
  const done = ownThen(steps, at);
  const kept = steps.filter((_one, index) => !gone.has(index));
  const place = kept.findIndex((one) => one.id === step.id);
  const set = (list: Step[], go: Step[ExitName]): Step[] => list.map((one, index) => (index === place ? withExit(one, exit, go) : one));

  if (choice === "stop") return { steps: tidyThen(forward(set(kept, undefined)).steps, place), removed: gone.size };
  // Where it goes when done, in the step's own words: "next" for one that says nothing, so a step put in after it
  // later is gone on to as well.
  if (choice === "goOn") return { steps: goesOnNext(tidyThen(forward(set(kept, step.then === undefined ? "next" : step.then === "end" ? undefined : step.then)).steps, place), place, exit), removed: gone.size };

  // A step of its own, right after the one it answers for: a wait whose yes goes on, or the first of a lane that
  // rejoins the main line. Where nothing follows, it is the last thing the run does.
  const id = newStepId(kept);
  const made: Step = choice === "ask" ? { id, kind: "approval", ask: "" } : { ...blankStep(lane, kept), id };
  const added = withExit(made, "then", done === "end" ? undefined : done);
  const list = [...kept.slice(0, place + 1), added, ...kept.slice(place + 1)].map((one, index) => (index === place ? withExit(withExit(one, "then", done), exit, { to: id }) : one));
  return { steps: forward(list).steps, opened: id, removed: gone.size };
}

/** Where a lane ends, set: back into the main line at the step its owner goes on to, or a stop. */
export function setLaneEnd(steps: readonly Step[], owner: number, exit: PathExit, ends: "stop" | "back"): Step[] {
  const rule = ruleOf(pathsOf(steps, false), owner, exit);
  if (rule?.kind !== "lane") return [...steps];
  const last = rule.lane.at(-1)!;
  const done = landsAt(steps, owner, "then");
  const go: Step["then"] = ends === "stop" || done === "end" ? "end" : { to: steps[done]!.id };
  return steps.map((step, index) => (index === last ? withExit(step, "then", go === "end" && index === steps.length - 1 ? undefined : go) : step));
}

/** A step added at a lane's end: it takes the lane's ending, and the step before it goes on to it. */
export function addToLane(steps: readonly Step[], owner: number, exit: PathExit, kind: StepKind): Chosen {
  const rule = ruleOf(pathsOf(steps, false), owner, exit);
  if (rule?.kind !== "lane" || steps.length >= STEPS_MAX) return { steps: [...steps], removed: 0 };
  const last = rule.lane.at(-1)!;
  const made = withExit(blankStep(kind, steps), "then", steps[last]!.then);
  const list = [...steps.slice(0, last + 1), made, ...steps.slice(last + 1)].map((step, index) => (index === last ? withExit(step, "then", { to: made.id }) : step));
  return { steps: tidyAll(forward(list).steps), opened: made.id, removed: 0 };
}

/** Every `then` that only names the step right after it, left out. */
const tidyAll = (steps: Step[]): Step[] => steps.reduce((list, _step, at) => tidyThen(list, at), steps);

/**
 * A step put on the main line before the step drawn at `before` (a place in the list), or at its end. The step drawn
 * above it, and the lanes that rejoin the line there, go on to the new step, which goes on to where they went.
 */
export function insertOnLine(steps: readonly Step[], before: number | null, step: Step): Step[] {
  const paths = pathsOf(steps, false);
  const place = before ?? steps.length;
  const target = before === null ? null : steps[before]!.id;
  const above = before === null ? (paths.line.at(-1) ?? null) : (paths.line[paths.line.indexOf(before) - 1] ?? null);
  // Those that led to the step it now stands before: the step above it and that step's own lanes.
  const group = new Set(above === null ? [] : [above, ...[...paths.inside].filter(([, within]) => within.owner === above).map(([at]) => at)]);
  const led = (go: Step[ExitName]): boolean => (target === null ? go === "end" : typeof go === "object" && go.to === target);
  const list = steps.map((one, index) => {
    // At the line's end, a lane's last step that ended the run by being the last of the list says so now: the new
    // step is after it, and it does not go on to it.
    if (target === null && index === steps.length - 1 && index !== above && one.then === undefined) return withExit(one, "then", "end");
    if (!group.has(index)) return one;
    let next = one;
    // At the line's end only the step above goes on: a lane that stopped still stops.
    for (const exit of ["then", "whenFailed", "whenEmpty"] as const) if (led(one[exit]) && (target !== null || (index === above && exit === "then"))) next = withExit(next, exit, { to: step.id });
    return next;
  });
  return tidyAll(forward([...list.slice(0, place), step, ...list.slice(place)]).steps);
}

/** A new step of a kind on the main line, before the step at `before` or at the line's end. Nothing past the most a job runs. */
export function addOnLine(steps: readonly Step[], before: number | null, kind: StepKind): Step[] {
  return steps.length >= STEPS_MAX ? [...steps] : insertOnLine(steps, before, blankStep(kind, steps));
}

/**
 * A copy of a step of the main line, drawn right below it: its words, its kind and its paths ahead, with an id of its
 * own and its name marked, and no steps of its own. A path into the first step's lane would point back from where the
 * copy stands, and a path only goes forward: `forward` puts it back to what a step does by default.
 */
export function copyOnLine(steps: readonly Step[], index: number): Step[] {
  const step = steps[index];
  const paths = pathsOf(steps, false);
  if (!step || steps.length >= STEPS_MAX || paths.inside.has(index)) return [...steps];
  const copy: Step = { ...withId(step, newStepId(steps)), ...(step.name ? { name: `${step.name} copy`.slice(0, 80) } : {}) };
  return insertOnLine(steps, nextOnLine(paths, index), copy);
}

/** A step and the steps of its rules: what moves and goes together. */
export function groupOf(steps: readonly Step[], at: number, paths: Paths = pathsOf(steps, false)): number[] {
  return [at, ...[...paths.inside].filter(([, within]) => within.owner === at).map(([index]) => index)].sort((a, b) => a - b);
}

/**
 * A step taken out with what hangs on it. One on the main line goes with the steps of its rules, and the step drawn
 * above it goes on to the step drawn below. One in a lane leaves the lane whole: the path that led to it leads to the
 * lane's next step, or the step before it takes its ending; a lane's only step takes the lane with it, and the path
 * is back to a stop.
 */
export function removeDrawn(steps: readonly Step[], at: number): Step[] {
  const paths = pathsOf(steps, false);
  const within = paths.inside.get(at);
  if (!within) return tidyAll(forward(lifted(steps, at, paths)).steps);
  const rule = ruleOf(paths, within.owner, within.exit);
  const lane = rule?.kind === "lane" ? rule.lane : [at];
  const place = lane.indexOf(at);
  const step = steps[at]!;
  const list = steps.map((one, index) => {
    // The first of several: the path leads to the second.
    if (index === within.owner && place === 0) return withExit(one, within.exit, lane.length > 1 ? { to: steps[lane[1]!]!.id } : undefined);
    // Any other: the step before it takes what it went on to, the lane's ending for the last.
    if (place > 0 && index === lane[place - 1]) return withExit(one, "then", step.then === undefined && lane[place + 1] !== undefined ? { to: steps[lane[place + 1]!]!.id } : step.then);
    return one;
  });
  const kept = forward(list.filter((_one, index) => index !== at)).steps;
  return tidyAll(lane.length > 1 ? kept : tidyThen(kept, kept.findIndex((one) => one.id === steps[within.owner]!.id)));
}

/**
 * The list with a step of the main line lifted out, and what hangs on it: the step drawn above it goes on to the step
 * drawn below. A path that named the step is left naming it: a delete then puts it back to its default, and a move
 * finds it again once the step is back in its new place.
 */
function lifted(steps: readonly Step[], at: number, paths: Paths): Step[] {
  const group = new Set(groupOf(steps, at, paths));
  const below = nextOnLine(paths, at);
  const gone = steps[at]!.id;
  return steps
    .map((step) => (typeof step.then === "object" && step.then.to === gone && below !== null ? withExit(step, "then", { to: steps[below]!.id }) : step))
    .filter((_step, index) => !group.has(index));
}

/**
 * A step of the main line moved to stand before another (`to`, a place on the line as drawn, counted without the step
 * itself), with what hangs on it. The line is rewired as a delete and an insert would: no path is left pointing back.
 */
export function moveOnLine(steps: readonly Step[], from: number, to: number): Step[] {
  const paths = pathsOf(steps, false);
  // Only a step of the main line moves along it: one of a lane stays with the step that owns it.
  if (!steps[from] || paths.inside.has(from) || to < 0) return [...steps];
  const group = groupOf(steps, from, paths);
  const moving = group.map((index) => steps[index]!);
  const without = lifted(steps, from, paths);
  const line = pathsOf(without, false).line;
  const before = line[to] ?? null;
  const [lead, ...rest] = moving as [Step, ...Step[]];
  // Its own `then` was the step that followed it where it stood: where it goes now is said by where it lands.
  const bare = rest.length === 0 ? withExit(lead, "then", lead.then === "end" ? "end" : undefined) : lead;
  const placed = insertOnLine(without, before, bare);
  if (rest.length === 0) return placed;
  // What hangs on it goes back in right after it, and everything that went on from the group goes on from where it is.
  const at = placed.findIndex((one) => one.id === lead.id);
  const done = landsAt(placed, at, "then");
  const goes: Step["then"] = done === "end" ? "end" : { to: placed[done]!.id };
  const was = ownThen(steps, from);
  const same = (go: Step[ExitName]): boolean => JSON.stringify(go) === JSON.stringify(was);
  const hung = rest.map((one) => (one.then !== undefined && same(one.then) ? withExit(one, "then", goes) : one));
  const list = [...placed.slice(0, at), withExit(lead, "then", goes), ...hung, ...placed.slice(at + 1)];
  return tidyAll(forward(list).steps);
}
