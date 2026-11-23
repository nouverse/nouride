/**
 * A list of steps as the page changes it: add, remove, move, duplicate, and where the run goes from each. Pure, so
 * every rule the server holds a list to is held here first and tested without a page (`tests/automation-steps.test.ts`).
 *
 * The one rule the page cannot leave to a refusal is that an exit only points forward. A step moved above the step
 * that pointed at it, or deleted from under it, would leave an exit the server refuses; every operation that changes
 * the order ends in `forward`, which puts such an exit back to what a step does when it does not say, and names it, so
 * the card can say what happened.
 */

import type { AutomationPart, AutomationStep, StepExit } from "@nouride/wire";

export type Step = AutomationStep;
export type StepKind = Step["kind"];
/** One of the steps a step starts at the same time: what to ask an agent, or a command. */
export type Part = AutomationPart;
type Together = Extract<Step, { kind: "parallel" }>;
export type ExitName = "then" | "whenFailed" | "whenEmpty";

export const EXITS: readonly ExitName[] = ["then", "whenFailed", "whenEmpty"];
export const KINDS: readonly StepKind[] = ["agentTurn", "command", "systemEvent", "mission", "approval", "parallel"];

/** The server's own bounds, as `cron/validate.ts` and `cron/steps.ts` hold them. */
export const STEPS_MAX = 20;
export const TOGETHER_MIN = 2;
export const TOGETHER_MAX = 5;
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
  const can: ExitName[] = step.kind === "systemEvent" ? ["then"] : step.kind === "command" || step.kind === "agentTurn" || step.kind === "parallel" ? ["then", "whenFailed", "whenEmpty"] : ["then", "whenFailed"];
  // One written elsewhere is still shown: the page hides nothing the automation holds.
  return EXITS.filter((exit) => can.includes(exit) || step[exit] !== undefined);
}

export const exitOf = (step: Step, exit: ExitName): StepExit => step[exit] ?? DEFAULT_EXIT[exit];

/**
 * Whether a step can be marked to go on only when what it says changes: one that says something of its own. A message
 * says what a person wrote and a wait hands on what the step before said, and the server refuses the mark on either.
 */
export const canWatch = (step: Pick<Step, "kind">): boolean => step.kind === "command" || step.kind === "agentTurn" || step.kind === "mission" || step.kind === "parallel";

/** A step with that mark set or taken off. The mark is there or it is not: never kept as off, and never on a kind that cannot hold it. */
export function watching(step: Step, on: boolean): Step {
  const { onlyChanged: _was, ...rest } = step;
  return (on && canWatch(step) ? { ...rest, onlyChanged: true } : rest) as Step;
}

/** Where an exit lands in the list: a step's place, or the run's end. The step after the last one is the end. */
export function landsAt(steps: readonly Step[], index: number, exit: ExitName): number | "end" {
  const go = exitOf(steps[index]!, exit);
  if (go === "end") return "end";
  if (go === "next") return index + 1 < steps.length ? index + 1 : "end";
  const to = steps.findIndex((step) => step.id === go.to);
  return to > index ? to : "end";
}

/** An id no step has yet: `s` and the first free number, as the server names a step sent without one. */
export function newStepId(steps: readonly Pick<Step, "id">[]): string {
  const taken = new Set(steps.map((step) => step.id));
  for (let n = steps.length + 1; ; n += 1) if (!taken.has(`s${n}`)) return `s${n}`;
}

/** One of the steps started at the same time, with nothing written in it yet. Its id is its step's to give (`parted`). */
export const blankPart = (kind: Part["kind"]): Part => (kind === "command" ? { id: "", kind, argv: [] } : { id: "", kind, message: "" });

/** What one of them asks or runs: a script is said by what it does, since its line is only the program that runs it. */
const partText = (part: Part): string => (part.kind === "command" ? (part.script ? part.script.about : shellLine(part.argv)) : part.message);

/** The same one as the other kind: its name and its words kept, an agent of its own dropped with the turn it was for. */
export function asPart(part: Part, kind: Part["kind"]): Part {
  if (part.kind === kind) return part;
  const base = { id: part.id, ...(part.name ? { name: part.name } : {}) };
  return kind === "command" ? { ...base, kind, argv: argvOf(partText(part)) } : { ...base, kind, message: partText(part) };
}

/**
 * A step of several at the same time with each of them named by its step's id and its place: no two steps of an
 * automation share an id, which the server holds a list to, however the step was copied, moved or renamed.
 */
export function parted(step: Together, parts: readonly Part[] = step.steps): Together {
  return { ...step, steps: parts.map((part, at) => ({ ...part, id: `${step.id.slice(0, 21)}-${at + 1}` })) };
}

/** A step under another id, the steps it starts at the same time named after it. */
export const withId = (step: Step, id: string): Step => (step.kind === "parallel" ? parted({ ...step, id }) : { ...step, id });

/**
 * What "Add a step" offers: each kind, and a mission that is drafted, which is the mission kind with `draft`. Its own
 * entry, since that list is where a person looks for what a step can do: with the draft only a field inside "Start a
 * mission", the list said an automation could do nothing but start one.
 */
export type StepPick = StepKind | "missionDraft";
export const PICKS: readonly StepPick[] = ["agentTurn", "command", "systemEvent", "mission", "missionDraft", "approval", "parallel"];
/** Which of them a step is. */
export const pickOf = (step: Pick<Step, "kind"> & { draft?: boolean }): StepPick => (step.kind === "mission" && step.draft ? "missionDraft" : step.kind);

/** A new step of a kind, with nothing written in it yet. */
export function blankStep(pick: StepPick, steps: readonly Step[]): Step {
  const id = newStepId(steps);
  if (pick === "missionDraft") return { id, kind: "mission", goal: "", draft: true };
  const kind: StepKind = pick;
  switch (kind) {
    case "parallel":
      return parted({ id, kind, steps: [blankPart("agentTurn"), blankPart("agentTurn")] });
    case "systemEvent":
      return { id, kind, text: "" };
    case "agentTurn":
      return { id, kind, message: "" };
    case "command":
      // A script, to be written or asked for: a line typed into it is a script of one line. The one-line form is what
      // an automation made before scripts holds, and is kept as it is.
      return { id, kind, argv: ["sh"], script: { text: "", about: "" } };
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
      return step.script ? step.script.about : shellLine(step.argv);
    case "mission":
      return step.goal;
    case "approval":
      return step.ask;
    case "parallel":
      return step.steps.map(partText).map((text) => text.trim()).filter(Boolean).join(" · ");
  }
}

/** The same step as another kind: its place, its name, its exits and its words kept, what only the old kind had dropped. */
export function asKind(step: Step, kind: StepKind): Step {
  if (step.kind === kind) return step;
  // Of several at the same time, the first is what goes on as the one thing the step does.
  const lead = step.kind === "parallel" ? step.steps[0] : step;
  const text = step.kind === "parallel" ? (lead ? partText(lead as Part) : "") : mainText(step);
  const base = { id: step.id, ...(step.name ? { name: step.name } : {}), ...(step.then ? { then: step.then } : {}) };
  const failed = step.whenFailed ? { whenFailed: step.whenFailed } : {};
  const empty = step.whenEmpty ? { whenEmpty: step.whenEmpty } : {};
  const agent = lead && "agentId" in lead && lead.agentId ? { agentId: lead.agentId } : {};
  // Kept by the kinds that say something of their own; a message or a wait cannot hold it.
  const watch = step.onlyChanged ? { onlyChanged: true as const } : {};
  switch (kind) {
    case "systemEvent":
      return { ...base, kind, text };
    case "agentTurn":
      return { ...base, ...failed, ...empty, ...watch, kind, message: text, ...agent };
    case "command":
      return { ...base, ...failed, ...empty, ...watch, kind, argv: argvOf(text) };
    case "mission":
      return { ...base, ...failed, ...watch, kind, goal: text, ...agent };
    case "approval":
      return { ...base, ...failed, kind, ask: text };
    case "parallel": {
      // What the step did is the first of them; the second is there to be written.
      const first: Part = step.kind === "command" ? { id: "", kind: "command", argv: step.argv } : { id: "", kind: "agentTurn", message: text, ...agent };
      return parted({ ...base, ...failed, ...empty, ...watch, kind, steps: [first, blankPart("agentTurn")] });
    }
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

/**
 * The paths a change to the list put back to their default, read off the list before and after: one that named a step
 * and now says nothing, where that step is gone or is no longer after it. A path the page rewrote on purpose names a
 * step that is still there and still ahead, and is not one of these.
 */
export function resetsBetween(was: readonly Step[], now: readonly Step[]): ExitReset[] {
  const before = new Map(was.map((step) => [step.id, step] as const));
  const place = new Map(now.map((step, index) => [step.id, index] as const));
  return now.flatMap((step, index) =>
    EXITS.flatMap((exit): ExitReset[] => {
      const go = before.get(step.id)?.[exit];
      if (typeof go !== "object" || step[exit] !== undefined) return [];
      const to = place.get(go.to);
      if (to === undefined) return [{ id: step.id, exit, why: "removed" }];
      return to <= index ? [{ id: step.id, exit, why: "moved" }] : [];
    }),
  );
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

/** A saved key's name, as the server takes one. */
const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * What a script lacks before the server would keep it: its text, the line that says what it does (a person turning the
 * automation on reads that before the text), a program of one word to run it, and saved keys named as they are saved.
 */
function scriptProblem(script: NonNullable<Extract<Step, { kind: "command" }>["script"]>, argv: readonly string[]): string | null {
  if (!script.text.trim()) return "Write the script, or ask an agent to write it.";
  if (!script.about.trim()) return "Say what the script does, in one line.";
  if (!argv[0]?.trim() || /\s/.test(argv[0])) return "Pick what the script is written in.";
  if ((script.secrets ?? []).some((name) => !KEY_NAME.test(name))) return "Check the saved keys it uses: each is one name, as it is saved.";
  return null;
}

function stepProblem(step: Step, own: string | undefined): string | null {
  if ((step.kind === "agentTurn" || step.kind === "mission") && step.agentId !== undefined && !step.agentId.trim()) return "Pick the agent for this step, or leave it to the automation's own.";
  switch (step.kind) {
    case "systemEvent":
      return step.text.trim() ? null : "Write the message to send.";
    case "agentTurn":
      return step.message.trim() ? null : "Write what to ask the agent.";
    case "command":
      if (step.script) return scriptProblem(step.script, step.argv);
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
    case "parallel": {
      if (step.steps.length < TOGETHER_MIN) return "Add at least two things to start at the same time.";
      if (step.steps.length > TOGETHER_MAX) return `At most ${TOGETHER_MAX} start at the same time.`;
      if (step.steps.some((part) => !partText(part).trim())) return "Write what each of them does: what to ask, or the command to run.";
      for (const part of step.steps) {
        const lacks = part.kind === "command" && part.script ? scriptProblem(part.script, part.argv) : null;
        if (lacks) return lacks;
      }
      // The automation's own agent stands for a part that names none: twice is twice either way.
      const agents = step.steps.flatMap((part) => (part.kind === "agentTurn" ? [part.agentId || own || ""] : []));
      return agents.some((agent, at) => agents.indexOf(agent) !== at) ? "An agent takes one of these at a time. Give each a different agent, or move one to a step of its own." : null;
    }
  }
}

/** Everything the server would refuse a list for, so nothing it would refuse is sent. */
export function stepProblems(steps: readonly Step[], own?: string): StepProblem[] {
  const problems: StepProblem[] = [];
  if (steps.length === 0) problems.push({ index: null, message: "Add a step: what should happen when it starts." });
  if (steps.length > STEPS_MAX) problems.push({ index: null, message: `An automation runs at most ${STEPS_MAX} steps.` });
  const place = new Map<string, number>();
  steps.forEach((step, index) => {
    if (!STEP_ID.test(step.id) || place.has(step.id)) problems.push({ index, message: "This step cannot be told from another. Duplicate it and delete this one." });
    else place.set(step.id, index);
  });
  steps.forEach((step, index) => {
    const said = stepProblem(step, own);
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
