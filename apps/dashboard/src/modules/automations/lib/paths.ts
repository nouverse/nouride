/**
 * A step's paths as the canvas says and draws them. Pure (`tests/automation-paths.test.ts`): nothing is stored for the
 * drawing, and every shape the page writes is one the daemon already runs.
 *
 * A path that leaves the main line was drawn as a chip, "If it fails → step 4", and its step stood in the list as if it
 * ran after the one above it. A person asked "and if it fails, then what?", and the page answered with a jump. So a
 * path is read as one of four answers:
 *
 * - **stop**: what a step does unless told otherwise. One quiet line in the step's own box, with a stop's mark: with
 *   nothing drawn, a person looked for the answer they had just chosen and found no sign of it.
 * - **go on**: the run goes where it goes when the step is done. One line in the step's own box.
 * - **ask**: a wait for a person's OK that only this path reaches, whose yes goes on and whose no ends the run. Drawn in
 *   the step's own box, with the question and both answers; the wait is no box of its own.
 * - **other steps** in its place: a lane at the step's side, which ends in one of two marks, back into the main line or
 *   a stop.
 *
 * A step of a lane answers for itself too, with the two answers that need no drawing of their own: stop, or go on to
 * where it goes when done. A lane of a lane is not drawn, so a question or other steps are a main-line step's to have.
 *
 * Anything else an automation holds (a jump between two steps of the main line, a step two paths reach, a step no path
 * reaches) stays on the main line at its place, with its path said in a chip as before. An automation written by hand
 * can hold any of them, and the page hides nothing it holds.
 *
 * The page writes a rule's steps right after the step that owns them, and sets that step's own `then` to the step that
 * followed: exits only point forward, so this is the one shape in which the main line never falls into a side step.
 */

import { DEFAULT_EXIT, STEPS_MAX, blankStep, exitsOf, forward, landsAt, newStepId, withId, type ExitName, type Step, type StepKind } from "./steps";

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
  // A lane's next step: every way into it is from the step before it, when that one is done among them. Its other
  // paths may lead there too: "go on anyway", chosen on a step of a lane.
  const follows = (at: number, from: number): boolean => {
    const ways = reached.get(at) ?? [];
    return ways.every((way) => way.from === from) && ways.some((way) => way.exit === "then");
  };
  const rules = new Map<number, Rule[]>();
  const inside = new Map<number, { owner: number; exit: PathExit; folded: boolean }>();
  /** A path of a step that leads where the step goes when done: it goes on anyway. */
  const goesOn = (at: number, exit: PathExit): boolean => {
    if (steps[at]![exit] === undefined) return false;
    const to = landsAt(steps, at, exit);
    return to !== "end" && to === landsAt(steps, at, "then");
  };

  for (const owner of main) {
    const done = landsAt(steps, owner, "then");
    for (const exit of PATH_EXITS) {
      if (steps[owner]![exit] === undefined) continue;
      const to = landsAt(steps, owner, exit);
      if (to === "end") continue;
      if (goesOn(owner, exit)) {
        rules.set(owner, [...(rules.get(owner) ?? []), { exit, kind: "goOn" }]);
        continue;
      }
      // Other steps in its place: reached by this path alone, each after the first by the one before it alone, and none
      // of them a step the run passes anyway.
      if (main.has(to) || !only(to, owner, exit)) continue;
      const lane = [to];
      let next = landsAt(steps, to, "then");
      while (next !== "end" && !main.has(next) && follows(next, lane.at(-1)!) && !lane.includes(next)) {
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
      // A lane's own steps: each says where it goes on anyway, in its own box.
      if (!(asks && fold)) for (const at of lane) for (const own of PATH_EXITS) if (goesOn(at, own)) rules.set(at, [...(rules.get(at) ?? []), { exit: own, kind: "goOn" }]);
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
 * about, and a step with nothing after it has nothing to go on to, asked or not. A step of a lane stops or goes on,
 * and has no steps of its own. What the step holds now is always
 * among them, whoever wrote it: an answer the page would not offer is still the one shown as chosen.
 */
export function choicesFor(steps: readonly Step[], at: number, exit: PathExit, paths: Paths = pathsOf(steps)): Choice[] {
  const goesOn = landsAt(steps, at, "then") !== "end";
  // A step of a lane: a question or other steps would be a lane of a lane, which the canvas does not draw.
  const side = paths.inside.has(at);
  const asks = !side && goesOn && exit === "whenFailed" && steps[at]!.kind !== "approval";
  const offered: Choice[] = ["stop", ...(goesOn ? (["goOn"] as const) : []), ...(asks ? (["ask"] as const) : []), ...(side ? [] : (["lane"] as const))];
  const now = choiceOf(steps, at, exit, paths);
  return offered.includes(now) ? offered : [...offered, now];
}

/**
 * The paths a step's box says end the run there: a failure (a no, for a wait) that no answer was chosen for. Silence
 * ending a run quietly is not said: it is what nearly every step does, and no failure.
 */
export function stopsAt(steps: readonly Step[], at: number, paths: Paths): PathExit[] {
  return exitsOf(steps[at]!).includes("whenFailed") && choiceOf(steps, at, "whenFailed", paths) === "stop" ? ["whenFailed"] : [];
}

/** The steps a rule holds, by their place. */
const held = (rule: Rule | undefined): number[] => (rule?.kind === "ask" ? [rule.at] : rule?.kind === "lane" ? rule.lane : []);

/** A step with one exit set, or taken off where it is what the step does anyway. */
function withExit(step: Step, exit: ExitName, go: Step[ExitName]): Step {
  const { [exit]: _was, ...rest } = step;
  return (go === undefined || go === DEFAULT_EXIT[exit] ? rest : { ...rest, [exit]: go }) as Step;
}

/**
 * A step with where it goes when done set, and each path of its that went on anyway set with it: "go on" stays "go
 * on" wherever on is now, and is taken off where there is nothing left to go on to. Without this a lane's step that
 * went on anyway was left pointing at the step it used to go on to, which the canvas then drew as a jump.
 *
 * A path goes on anyway when it says what `then` says: "the next step" where that is where the step goes, or the
 * same step by name. One that names a step by hand, while the step itself only goes on down the list, means that
 * step wherever it moves, and is left naming it.
 */
function withThen(steps: readonly Step[], at: number, go: Step["then"]): Step {
  const step = steps[at]!;
  const done = landsAt(steps, at, "then");
  const said = step.then;
  const along = PATH_EXITS.filter((exit) => {
    const path = step[exit];
    if (path === "next") return done !== "end" && landsAt(steps, at, exit) === done;
    return typeof path === "object" && typeof said === "object" && path.to === said.to;
  });
  // To the run's end is what a path does unsaid: `withExit` takes it off.
  return along.reduce((next, exit) => withExit(next, exit, go ?? "next"), withExit(step, "then", go));
}

/**
 * The last step of a list ends the run by being the last, and has nothing to go on to: it says neither. A path left
 * saying "go on to the next step" on a step that had become the last was no rule, and the canvas drew none; a step put
 * after it later brought it back to life, as a jump into that step nobody had asked for.
 */
function lastUnsaid(steps: readonly Step[]): Step[] {
  const last = steps.length - 1;
  return steps.map((step, at) => (at === last ? PATH_EXITS.reduce((one, exit) => (one[exit] === "next" ? withExit(one, exit, undefined) : one), step.then === "end" ? withExit(step, "then", undefined) : step) : step));
}

/**
 * The list with a step's `then` said in the fewest words: left out where the step it names is the one right after it,
 * which is what a step with no `then` does. Written out again by `ownThen` when a rule's steps go in between.
 */
function tidyThen(steps: Step[], at: number): Step[] {
  const go = steps[at]?.then;
  if (typeof go !== "object" || steps[at + 1]?.id !== go.to) return steps;
  // A path that named the same step went on anyway: it says "the next step" now, as the step does by saying nothing.
  const unsaid = (step: Step): Step =>
    PATH_EXITS.reduce((one, exit) => {
      const path = one[exit];
      return typeof path === "object" && path.to === go.to ? withExit(one, exit, "next") : one;
    }, withExit(step, "then", undefined));
  return steps.map((step, index) => (index === at ? unsaid(step) : step));
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
export function choosePath(given: readonly Step[], at: number, exit: PathExit, choice: Exclude<Choice, "jump">, lane: StepKind = "agentTurn"): Chosen {
  const steps = lastUnsaid(given);
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
  // rejoins the main line. Where nothing follows, it is the last thing the run does, and says so: the steps of the
  // step's other path may stand after it in the list, and it would run into them.
  const id = newStepId(kept);
  const made: Step = choice === "ask" ? { id, kind: "approval", ask: "" } : { ...blankStep(lane, kept), id };
  const added = withExit(made, "then", done);
  // The step says by name where it goes when done, and so does a path of its that went on anyway: said as "the next
  // step", it would go on into the step just put after it.
  const list = [...kept.slice(0, place + 1), added, ...kept.slice(place + 1)].map((one, index) => (index === place ? withExit(withThen(kept, place, done), exit, { to: id }) : one));
  return { steps: lastUnsaid(forward(list).steps), opened: id, removed: gone.size };
}

/**
 * The steps of the main line a lane can go back to: those the run passes after the step the lane hangs on, in the
 * order it passes them. Each stands after the lane in the list, since a path only goes forward.
 */
export function laneBacks(steps: readonly Step[], owner: number, lane: readonly number[]): number[] {
  const last = Math.max(owner, ...lane);
  const found: number[] = [];
  for (let at = landsAt(steps, owner, "then"); at !== "end" && !found.includes(at); at = landsAt(steps, at, "then")) if (at > last) found.push(at);
  return found;
}

/** Where a lane ends, as it is asked for: a stop, back where its step goes on (`back`), or back at a step by its id. */
export type LaneEnds = "stop" | "back" | { to: string };

/**
 * Where a lane ends, set: a stop, or back into the main line at any step the run passes after the one the lane hangs
 * on. It was the next step or nothing: other steps in a step's place often end past the step that follows it.
 */
export function setLaneEnd(steps: readonly Step[], owner: number, exit: PathExit, ends: LaneEnds): Step[] {
  const rule = ruleOf(pathsOf(steps, false), owner, exit);
  if (rule?.kind !== "lane") return [...steps];
  const last = rule.lane.at(-1)!;
  const backs = laneBacks(steps, owner, rule.lane);
  const back = typeof ends === "object" ? backs.find((at) => steps[at]!.id === ends.to) : backs[0];
  // A step it cannot go back to (one behind it, one of another lane, one that is gone) changes nothing.
  if (typeof ends === "object" && back === undefined) return [...steps];
  const go: Step["then"] = ends === "stop" || back === undefined ? "end" : { to: steps[back]!.id };
  return steps.map((step, index) => (index === last ? withThen(steps, index, go === "end" && index === steps.length - 1 ? undefined : go) : step));
}

/** A step added at a lane's end: it takes the lane's ending, and the step before it goes on to it. */
export function addToLane(given: readonly Step[], owner: number, exit: PathExit, kind: StepKind): Chosen {
  const steps = lastUnsaid(given);
  const rule = ruleOf(pathsOf(steps, false), owner, exit);
  if (rule?.kind !== "lane" || steps.length >= STEPS_MAX) return { steps: [...steps], removed: 0 };
  const last = rule.lane.at(-1)!;
  const made = withExit(blankStep(kind, steps), "then", steps[last]!.then);
  const list = [...steps.slice(0, last), withThen(steps, last, { to: made.id }), made, ...steps.slice(last + 1)];
  return { steps: tidyAll(forward(list).steps), opened: made.id, removed: 0 };
}

/** Every `then` that only names the step right after it, left out, and the last step saying nothing of what it cannot do. */
const tidyAll = (steps: Step[]): Step[] => lastUnsaid(steps.reduce((list, _step, at) => tidyThen(list, at), steps));

/**
 * A step put on the main line before the step drawn at `before` (a place in the list), or at its end. The step drawn
 * above it, and the lanes that rejoin the line there, go on to the new step, which goes on to where they went.
 */
export function insertOnLine(given: readonly Step[], before: number | null, step: Step): Step[] {
  const steps = lastUnsaid(given);
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
    if (place > 0 && index === lane[place - 1]) return withThen(steps, index, step.then === undefined && lane[place + 1] !== undefined ? { to: steps[lane[place + 1]!]!.id } : step.then);
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
    // With nothing drawn below, what led to it ends the run, and says so: a step with steps of its own after it in the
    // list would go on into them.
    .map((step, index) => (typeof step.then === "object" && step.then.to === gone ? withThen(steps, index, below === null ? "end" : { to: steps[below]!.id }) : step))
    .filter((_step, index) => !group.has(index));
}

/**
 * A step of the main line moved to another place on it (`to`, a place on the line as drawn, counted without the step
 * itself), with what hangs on it. The line is then drawn in its new order, and run in it: every step that went on to
 * the step drawn below it goes on to the step drawn below it now.
 *
 * It was rewired as a delete and an insert, and a step with steps in its place kept the `then` it had: dragged up the
 * line it still went on to the step that used to follow it, past every box it had been dragged over. Those boxes were
 * drawn and never run, and the canvas said so only in a small label ("Once done → step 5").
 *
 * A lane keeps where it ends. A stop stays a stop. One that went back where its step goes on, goes back where that
 * step goes on now; one set to a step further down still names it while that step is below, and else goes back where
 * its step goes on. A path that names a step by hand is left naming it, and `forward` puts it back to what a step does
 * by default where that step is no longer ahead.
 */
export function moveOnLine(given: readonly Step[], from: number, to: number): Step[] {
  const steps = lastUnsaid(given);
  const paths = pathsOf(steps, false);
  // Only a step of the main line moves along it: one of a lane stays with the step that owns it.
  if (!steps[from] || paths.inside.has(from) || to < 0) return [...steps];
  const line = paths.line;
  const order = line.filter((at) => at !== from);
  order.splice(Math.min(to, order.length), 0, from);
  if (order.every((at, place) => at === line[place])) return [...steps];
  const below = (of: readonly number[], at: number): number | null => of[of.indexOf(at) + 1] ?? null;

  // Where each step of the line, and the last step of each lane, goes when done in the new order: a step, or the end.
  const goes = new Map<number, number | null>();
  for (const at of line) {
    const [was, now] = [below(line, at), below(order, at)];
    if (landsAt(steps, at, "then") === (was ?? "end")) goes.set(at, now);
    for (const rule of paths.rules.get(at) ?? []) {
      if (rule.kind !== "lane") continue;
      goes.set(rule.lane.at(-1)!, rule.ends === "stop" ? null : rule.ends.back !== was && order.indexOf(rule.ends.back) > order.indexOf(at) ? rule.ends.back : now);
    }
  }
  // Each step of the line in its new place, with what hangs on it right after it. Where a step goes on to the one
  // right after it in the list it says nothing, and a path that went on anyway says "the next step": said by name,
  // a path that names that step by hand would be read as going on anyway from then on.
  const placed = order.flatMap((at) => groupOf(steps, at, paths));
  const said = (at: number, to: number | null): Step["then"] => {
    const next = placed[placed.indexOf(at) + 1];
    if (to === null) return next === undefined ? undefined : "end";
    return next === to ? undefined : { to: steps[to]!.id };
  };
  const list = placed.map((at) => (goes.has(at) ? withThen(steps, at, said(at, goes.get(at)!)) : steps[at]!));
  return tidyAll(forward(list).steps);
}
