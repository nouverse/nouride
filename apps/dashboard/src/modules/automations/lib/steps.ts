/**
 * A list of steps as the page changes it: add, remove, move, duplicate, and where the run goes from each. Pure, so
 * every rule the server holds a list to is held here first and tested without a page (`tests/automation-steps.test.ts`).
 *
 * The one rule the page cannot leave to a refusal is that an exit only points forward. A step moved above the step
 * that pointed at it, or deleted from under it, would leave an exit the server refuses; every operation that changes
 * the order ends in `forward`, which puts such an exit back to what a step does when it does not say, and names it, so
 * the card can say what happened.
 */

import type { AutomationStep, StepExit } from "@nouride/wire";
import { moved } from "@/commons/lib/reorder";

export type Step = AutomationStep;
export type StepKind = Step["kind"];
export type ExitName = "then" | "whenFailed" | "whenEmpty";

export const EXITS: readonly ExitName[] = ["then", "whenFailed", "whenEmpty"];
export const KINDS: readonly StepKind[] = ["agentTurn", "command", "systemEvent", "mission", "approval"];

/** The server's own bounds, as `cron/validate.ts` and `cron/steps.ts` hold them. */
export const STEPS_MAX = 20;
export const APPROVAL_WAIT_MS = 86_400_000;
const APPROVAL_WAIT_MIN_MS = 5 * 60_000;
const APPROVAL_WAIT_MAX_MS = 7 * 86_400_000;
const STEP_ID = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const GOAL_MAX = 2000;
const CHECKS_MAX = 10;
const CHECK_MAX = 500;
const REVIEW_MAX = 1000;

/** Where a run goes from a step that does not say: on when it is done, and to its end when it failed or said nothing. */
export const DEFAULT_EXIT: Record<ExitName, "next" | "end"> = { then: "next", whenFailed: "end", whenEmpty: "end" };

/** An exit put back to its default, and why: the step it pointed at is gone, or is no longer after it. */
export interface ExitReset {
  id: string;
  exit: ExitName;
  why: "removed" | "moved";
}

export interface Changed {
  steps: Step[];
  reset: ExitReset[];
}

/** Which exits a kind can take: only a command or an agent can have nothing to say, and a message sent has no other way out. */
export function exitsOf(step: Step): ExitName[] {
  const can: ExitName[] = step.kind === "systemEvent" ? ["then"] : step.kind === "command" || step.kind === "agentTurn" ? ["then", "whenFailed", "whenEmpty"] : ["then", "whenFailed"];
  // One written elsewhere is still shown: the page hides nothing the automation holds.
  return EXITS.filter((exit) => can.includes(exit) || step[exit] !== undefined);
}

export const exitOf = (step: Step, exit: ExitName): StepExit => step[exit] ?? DEFAULT_EXIT[exit];

/** Where an exit lands in the list: a step's place, or the run's end. The step after the last one is the end. */
export function landsAt(steps: readonly Step[], index: number, exit: ExitName): number | "end" {
  const go = exitOf(steps[index]!, exit);
  if (go === "end") return "end";
  if (go === "next") return index + 1 < steps.length ? index + 1 : "end";
  const to = steps.findIndex((step) => step.id === go.to);
  return to > index ? to : "end";
}

/** A path a step says for itself, where the run would otherwise do what a step does by default. */
export interface Branch {
  exit: ExitName;
  to: number | "end";
  /** It lands further on than the step right after: drawn as a line at the side, where "go on" is the line already there. */
  jump: boolean;
}

/** The paths a step says for itself: only these are drawn under its card. */
export function branchesOf(steps: readonly Step[], index: number): Branch[] {
  const step = steps[index]!;
  return EXITS.flatMap((exit): Branch[] => {
    const go = step[exit];
    if (go === undefined || go === DEFAULT_EXIT[exit]) return [];
    const to = landsAt(steps, index, exit);
    return [{ exit, to, jump: to !== "end" && to > index + 1 }];
  });
}

/** An id no step has yet: `s` and the first free number, as the server names a step sent without one. */
export function newStepId(steps: readonly Pick<Step, "id">[]): string {
  const taken = new Set(steps.map((step) => step.id));
  for (let n = steps.length + 1; ; n += 1) if (!taken.has(`s${n}`)) return `s${n}`;
}

/** A new step of a kind, with nothing written in it yet. */
export function blankStep(kind: StepKind, steps: readonly Step[]): Step {
  const id = newStepId(steps);
  switch (kind) {
    case "systemEvent":
      return { id, kind, text: "" };
    case "agentTurn":
      return { id, kind, message: "" };
    case "command":
      return { id, kind, argv: [] };
    case "mission":
      return { id, kind, goal: "" };
    case "approval":
      return { id, kind, ask: "" };
  }
}

/** A command as the line a person types, and back: the page writes a shell line, and reads one written elsewhere joined. */
export function shellLine(argv: readonly string[]): string {
  if (argv[0] === "sh" && argv[1] === "-lc" && argv.length === 3) return argv[2]!;
  return argv.join(" ");
}
/** As it is typed, spaces and all: a line trimmed at every key could never have a second word. An empty one is no command. */
export const argvOf = (line: string): string[] => (line === "" ? [] : ["sh", "-lc", line]);

/** What a step says or asks, whatever its kind: the text its card shows and its editor's main field holds. */
export function mainText(step: Step): string {
  switch (step.kind) {
    case "systemEvent":
      return step.text;
    case "agentTurn":
      return step.message;
    case "command":
      return shellLine(step.argv);
    case "mission":
      return step.goal;
    case "approval":
      return step.ask;
  }
}

/** The same step as another kind: its place, its name, its exits and its words kept, what only the old kind had dropped. */
export function asKind(step: Step, kind: StepKind): Step {
  if (step.kind === kind) return step;
  const text = mainText(step);
  const base = { id: step.id, ...(step.name ? { name: step.name } : {}), ...(step.then ? { then: step.then } : {}) };
  const failed = step.whenFailed ? { whenFailed: step.whenFailed } : {};
  const empty = step.whenEmpty ? { whenEmpty: step.whenEmpty } : {};
  const agent = "agentId" in step && step.agentId ? { agentId: step.agentId } : {};
  switch (kind) {
    case "systemEvent":
      return { ...base, kind, text };
    case "agentTurn":
      return { ...base, ...failed, ...empty, kind, message: text, ...agent };
    case "command":
      return { ...base, ...failed, ...empty, kind, argv: argvOf(text) };
    case "mission":
      return { ...base, ...failed, kind, goal: text, ...agent };
    case "approval":
      return { ...base, ...failed, kind, ask: text };
  }
}

/** Every exit that points at a step which is gone or no longer after it, put back to its default and named. */
export function forward(steps: readonly Step[]): Changed {
  const place = new Map(steps.map((step, index) => [step.id, index] as const));
  const reset: ExitReset[] = [];
  const kept = steps.map((step, index) => {
    let next: Step = step;
    for (const exit of EXITS) {
      const go = step[exit];
      if (go === undefined || go === "next" || go === "end") continue;
      const to = place.get(go.to);
      if (to !== undefined && to > index) continue;
      const { [exit]: _gone, ...rest } = next;
      next = rest as Step;
      reset.push({ id: step.id, exit, why: to === undefined ? "removed" : "moved" });
    }
    return next;
  });
  return { steps: kept, reset };
}

/** A step put in at a place. Past the most a job runs, nothing changes: the page offers no way to ask. */
export function insertStep(steps: readonly Step[], at: number, step: Step): Changed {
  if (steps.length >= STEPS_MAX) return { steps: [...steps], reset: [] };
  const place = Math.max(0, Math.min(at, steps.length));
  const taken = steps.some((one) => one.id === step.id);
  return forward([...steps.slice(0, place), taken ? { ...step, id: newStepId(steps) } : step, ...steps.slice(place)]);
}

export function removeStep(steps: readonly Step[], index: number): Changed {
  return forward(steps.filter((_, at) => at !== index));
}

/** A step taken from one place to another: `to` is where it ends up. */
export function moveStep(steps: readonly Step[], from: number, to: number): Changed {
  return forward(moved(steps, from, to));
}

/** A copy right after the step it copies, with an id of its own. Its exits still point at later steps, so they stay. */
export function duplicateStep(steps: readonly Step[], index: number): Changed {
  const step = steps[index];
  if (!step) return { steps: [...steps], reset: [] };
  return insertStep(steps, index + 1, { ...step, id: newStepId(steps), ...(step.name ? { name: `${step.name} copy`.slice(0, 80) } : {}) });
}

/** One step changed, the rest as they were. */
export function replaceStep(steps: readonly Step[], index: number, step: Step): Step[] {
  return steps.map((one, at) => (at === index ? step : one));
}

/**
 * Where the run goes from a step, set. A choice that is the default is left out, as a step that does not say; one that
 * points at a step which is not after it is not taken.
 */
export function setExit(steps: readonly Step[], index: number, exit: ExitName, go: StepExit): Step[] {
  const step = steps[index];
  if (!step) return [...steps];
  if (typeof go === "object" && !(steps.findIndex((one) => one.id === go.to) > index)) return [...steps];
  const { [exit]: _was, ...rest } = step;
  return replaceStep(steps, index, (go === DEFAULT_EXIT[exit] ? rest : { ...rest, [exit]: go }) as Step);
}

/** An exit as the value a dropdown holds, and back: `next`, `end`, or `to:` and a later step's id. */
export const exitValue = (go: StepExit): string => (typeof go === "object" ? `to:${go.to}` : go);
export const exitFrom = (value: string): StepExit => (value === "next" || value === "end" ? value : { to: value.slice(3) });

/** One thing wrong with a list, at a step or with the list as a whole (`index` null). */
export interface StepProblem {
  index: number | null;
  message: string;
}

function stepProblem(step: Step): string | null {
  if ((step.kind === "agentTurn" || step.kind === "mission") && step.agentId !== undefined && !step.agentId.trim()) return "Pick the agent for this step, or leave it to the automation's own.";
  switch (step.kind) {
    case "systemEvent":
      return step.text.trim() ? null : "Write the message to send.";
    case "agentTurn":
      return step.message.trim() ? null : "Write what to ask the agent.";
    case "command":
      return step.argv.every((part) => typeof part === "string") && shellLine(step.argv).trim() ? null : "Write the command to run.";
    case "mission": {
      if (!step.goal.trim()) return "Write the mission's goal: what should be true when it is done.";
      if (step.goal.length > GOAL_MAX) return `Keep the goal under ${GOAL_MAX} characters.`;
      const checks = step.checks ?? [];
      if (checks.length > CHECKS_MAX || checks.some((check) => !check.trim() || check.length > CHECK_MAX)) return `A mission takes at most ${CHECKS_MAX} checks, each under ${CHECK_MAX} characters.`;
      if (typeof step.review === "string" && step.review.length > REVIEW_MAX) return `Keep the reviewer's words under ${REVIEW_MAX} characters.`;
      return null;
    }
    case "approval":
      if (!step.ask.trim()) return "Write the question to ask.";
      if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs < APPROVAL_WAIT_MIN_MS || step.timeoutMs > APPROVAL_WAIT_MAX_MS)) return "It can wait between 5 minutes and 7 days.";
      return null;
  }
}

/** Everything the server would refuse a list for, so nothing it would refuse is sent. */
export function stepProblems(steps: readonly Step[]): StepProblem[] {
  const problems: StepProblem[] = [];
  if (steps.length === 0) problems.push({ index: null, message: "Add a step: what should happen when it starts." });
  if (steps.length > STEPS_MAX) problems.push({ index: null, message: `An automation runs at most ${STEPS_MAX} steps.` });
  const place = new Map<string, number>();
  steps.forEach((step, index) => {
    if (!STEP_ID.test(step.id) || place.has(step.id)) problems.push({ index, message: "This step cannot be told from another. Duplicate it and delete this one." });
    else place.set(step.id, index);
  });
  steps.forEach((step, index) => {
    const said = stepProblem(step);
    if (said) problems.push({ index, message: said });
    for (const exit of EXITS) {
      const go = step[exit];
      if (go === undefined || go === "next" || go === "end") continue;
      const to = place.get(go.to);
      if (to === undefined || to <= index) problems.push({ index, message: "One of its paths leads to a step that is not after it." });
    }
  });
  return problems;
}

/** The step a refusal names ("step 3: …"), as its place in the list; null when it names none. */
export function refusedStep(error: string | undefined): number | null {
  const found = /\bstep (\d+)\b/.exec(error ?? "");
  return found ? Number(found[1]) - 1 : null;
}
