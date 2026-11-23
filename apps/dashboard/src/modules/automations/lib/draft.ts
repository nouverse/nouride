/**
 * An automation as the page holds it while it is edited, and what a save sends. Pure (`tests/automation-draft.test.ts`).
 *
 * The page always draws steps, and an automation's work is one thing or a list of them. One made before lists is drawn
 * as a single step and saved as the one thing it is; it becomes a list when a second step is added, or when its step
 * takes something only a list holds (a name, another agent, a path of its own, a wait for a person, the mark to go on
 * only when what it says changes). Two things change
 * with it, and both are done here so the page can say them before the save: a command that handed its output to its
 * agent becomes the command and a step for that agent, and an automation that read its chat's history starts each run
 * clean, since a list keeps a history of its own.
 *
 * A change sends what changed and nothing else: a start that is a moment already past, sent again, would be refused.
 */

import type { AutomationStart, AutomationSummary, JobInput, JobPatch, JobPayloadInput, WebhookInput } from "@nouride/wire";
import { draftFromTrigger, triggerBody, type TriggerDraft } from "./trigger";
import { EXITS, newStepId, stepProblems, type Step, type StepProblem } from "./steps";
import { drawnName } from "./words";

type OneThing = Exclude<JobPayloadInput, { kind: "steps" }>;
/** What a lone command's output is worth: posted as it is, or handed to the automation's agent. */
export type Then = Extract<OneThing, { kind: "command" }>["then"];
type Delivery = AutomationSummary["delivery"];

export interface Draft {
  name: string;
  agentId: string;
  start: AutomationStart;
  trigger: TriggerDraft;
  /** Whether a start at one moment stays listed after it ran: asked only when the automation is made. */
  keepAfterRun: boolean;
  gatewayId: string;
  chatId: string;
  /**
   * Whether a run tells its chat, and its two marks: tell once and turn off, tell at once whatever the hour.
   * `webhook`, set elsewhere, is kept as it is: the page has no field for its address.
   */
  delivery: Delivery;
  session: AutomationSummary["session"];
  steps: Step[];
  then: Then;
  /** Loaded as a list: a list stays one, however short. */
  list: boolean;
}

/** What the agent step that takes a command's place is asked: what one turn was told about a command's output before. */
export const READS_OUTPUT = "Say what the output of the command before this step means.";

/** The id of the one step a job of one thing is drawn as: what the first step of a new list is called too. */
const ONE = "s1";

/** One thing as the step it is drawn as. */
function stepOfOne(payload: AutomationSummary["payload"]): Step {
  const one = payload as unknown as OneThing;
  switch (one.kind) {
    case "systemEvent":
      return { id: ONE, kind: "systemEvent", text: one.text ?? "" };
    case "agentTurn":
      return { id: ONE, kind: "agentTurn", message: one.message ?? "", ...(one.model ? { model: one.model } : {}) };
    case "command":
      // A script it keeps goes with it: a page that dropped it would save a job that runs its program on nothing.
      return { id: ONE, kind: "command", argv: Array.isArray(one.argv) ? one.argv.map(String) : [], ...(one.script ? { script: one.script } : {}), ...(one.cwd ? { cwd: one.cwd } : {}), ...(typeof one.timeoutMs === "number" ? { timeoutMs: one.timeoutMs } : {}) };
    case "mission":
      return { id: ONE, kind: "mission", goal: one.goal ?? "", ...(one.checks?.length ? { checks: one.checks } : {}), ...(one.review !== undefined ? { review: one.review } : {}), ...(one.draft ? { draft: true as const } : {}) };
  }
}

/** The steps an automation runs, whichever way it holds them. */
export function stepsOf(payload: AutomationSummary["payload"]): Step[] {
  if (payload.kind === "steps") return Array.isArray(payload.steps) ? (payload.steps as Step[]) : [];
  return [stepOfOne(payload)];
}

export function draftOf(automation: AutomationSummary, timezone: string): Draft {
  return {
    name: automation.name,
    agentId: automation.agentId,
    start: automation.start,
    trigger: draftFromTrigger(automation.trigger, timezone),
    keepAfterRun: false,
    gatewayId: automation.target.gatewayId,
    chatId: automation.target.chatId,
    delivery: automation.delivery,
    session: automation.session,
    steps: stepsOf(automation.payload),
    then: automation.payload.kind === "command" && automation.payload.then === "agentTurn" ? "agentTurn" : "deliver",
    list: automation.payload.kind === "steps",
  };
}

/** A new automation before anything is written: scheduled, one agent, its first connection, no steps yet. */
export function blankDraft(agentId: string, gatewayId: string, timezone: string): Draft {
  return {
    name: "",
    agentId,
    start: "scheduled",
    trigger: draftFromTrigger(undefined, timezone),
    keepAfterRun: false,
    gatewayId,
    chatId: "",
    delivery: { mode: "announce" },
    session: "fresh",
    steps: [],
    then: "deliver",
    list: false,
  };
}

/**
 * What only a step of a list can hold: a name, an agent of its own, a path of its own, a wait for a person, the mark
 * to go on only when what it says changes.
 */
function listOnly(step: Step): boolean {
  if (step.kind === "approval" || step.kind === "parallel" || step.name?.trim() || step.onlyChanged) return true;
  if ((step.kind === "agentTurn" || step.kind === "mission") && step.agentId) return true;
  return EXITS.some((exit) => step[exit] !== undefined);
}

export function savesAsList(draft: Pick<Draft, "steps" | "list">): boolean {
  return draft.list || draft.steps.length !== 1 || listOnly(draft.steps[0]!);
}

/** The steps a save sends: a lone command that woke its agent, as a list, is that command and a step for the agent. */
export function listedSteps(draft: Pick<Draft, "steps" | "then" | "list">): Step[] {
  const [only] = draft.steps;
  if (draft.list || draft.steps.length !== 1 || only?.kind !== "command" || draft.then !== "agentTurn") return draft.steps;
  return [only, { id: newStepId(draft.steps), kind: "agentTurn", message: READS_OUTPUT }];
}

export function payloadOf(draft: Pick<Draft, "steps" | "then" | "list">): JobPayloadInput {
  if (savesAsList(draft)) return { kind: "steps", steps: listedSteps(draft) };
  const step = draft.steps[0]!;
  switch (step.kind) {
    case "systemEvent":
      return { kind: "systemEvent", text: step.text.trim() };
    case "agentTurn":
      return { kind: "agentTurn", message: step.message.trim(), ...(step.model ? { model: step.model } : {}) };
    case "command":
      return { kind: "command", argv: step.argv, ...(step.script ? { script: step.script } : {}), ...(step.cwd ? { cwd: step.cwd } : {}), ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}), then: draft.then };
    case "mission":
      return { kind: "mission", goal: step.goal.trim(), ...(step.checks?.length ? { checks: step.checks } : {}), ...(step.review !== undefined ? { review: step.review } : {}), ...(step.draft ? { draft: true as const } : {}) };
    case "approval":
    case "parallel":
      // Unreachable: a wait for a person, and several at the same time, are only ever steps of a list (`listOnly`).
      return { kind: "steps", steps: [step] };
  }
}

const hasMission = (draft: Pick<Draft, "steps">): boolean => draft.steps.some((step) => step.kind === "mission");

/**
 * Where a run reports, as it is saved: a mission tells its chat when it is done or needs someone, whatever was picked.
 * And one that tells nobody is not sent as turning itself off once it has told: it never would, and the server refuses
 * the two together. The draft keeps the mark, so telling switched back on finds it as it was left.
 */
export function deliveryOf(draft: Pick<Draft, "steps" | "delivery"> & Partial<Pick<Draft, "start" | "trigger">>): Delivery {
  const told: Delivery = hasMission(draft) && draft.delivery.mode !== "announce" ? { ...draft.delivery, mode: "announce" } : draft.delivery;
  const delivery = onAClock(draft) ? told : notLasting(told);
  if (delivery.mode !== "none" || !delivery.once) return delivery;
  const { once: _once, ...tellsNobody } = delivery;
  return tellsNobody;
}

/**
 * Whether it runs again and again at a time, which is the only thing that can last a set time: one that starts once,
 * by hand or when its address is called has no clock to stop on, and the server refuses a length for it. Unknown where
 * the caller did not say how it starts: left as it is.
 */
export function onAClock(draft: Partial<Pick<Draft, "start" | "trigger">>): boolean {
  if (draft.start === undefined) return true;
  return draft.start === "scheduled" && draft.trigger?.mode !== "once";
}

/** A delivery with no length to last: what one that is not on a clock is saved with. The draft keeps it, for a start put back. */
function notLasting(delivery: Delivery): Delivery {
  const { lasts: _lasts, endsAt: _endsAt, ...rest } = delivery;
  return rest;
}

/** A delivery set to last a length of time, or with none. The moment it ends is the server's to write, and is left out. */
export function withLasts(delivery: Delivery, lasts: number | undefined): Delivery {
  const rest = notLasting(delivery);
  return lasts === undefined ? rest : { ...rest, lasts };
}

/**
 * A delivery with one of its two marks set or taken off, and the rest of it as it was: the chat it reports to instead
 * of its own, an address set elsewhere. A mark is there or it is not, and the two stand in the order the server writes
 * them, so a mark put back is the delivery that was loaded and not a change to save.
 */
export function withMark(delivery: Delivery, mark: "once" | "atOnce", on: boolean): Delivery {
  const { once, atOnce, ...rest } = delivery;
  const marks = { once, atOnce, [mark]: on };
  return { ...rest, ...(marks.once ? { once: true as const } : {}), ...(marks.atOnce ? { atOnce: true as const } : {}) };
}

/** What it keeps between runs, as it is saved: a list never reads its chat's history. */
export function sessionOf(draft: Pick<Draft, "steps" | "list" | "session">): Draft["session"] {
  return draft.session === "chat" && savesAsList(draft) ? "fresh" : draft.session;
}

/** The start's fields of a body: a time as the server parses it, `manual`, or nothing for a webhook. */
function startBody(draft: Pick<Draft, "start" | "trigger">): Pick<JobPatch, "at" | "every" | "cron" | "tz" | "manual"> {
  if (draft.start === "manual") return { manual: true };
  return draft.start === "scheduled" ? triggerBody(draft.trigger) : {};
}

/** One thing missing or wrong before a save, and the part of the page it is in. */
export interface DraftProblem {
  part: "name" | "start" | "who" | "steps";
  message: string;
}

export function draftProblems(draft: Draft): { problems: DraftProblem[]; steps: StepProblem[] } {
  const problems: DraftProblem[] = [];
  if (!draft.name.trim()) problems.push({ part: "name", message: "Give it a name." });
  if (draft.start === "scheduled" && Object.keys(triggerBody(draft.trigger)).length === 0) problems.push({ part: "start", message: "Say when it starts." });
  if (!draft.agentId) problems.push({ part: "who", message: "Pick the agent that runs it." });
  if (!draft.gatewayId || !draft.chatId.trim()) problems.push({ part: "who", message: "Pick the chat it reports to." });
  const steps = stepProblems(draft.steps, draft.agentId);
  // Named as it is drawn: a step under a lane is not "step 5" because two steps of the list hang beside the one over it.
  if (steps.length > 0) problems.push({ part: "steps", message: steps[0]!.index === null ? steps[0]!.message : `${drawnName(draft.steps, steps[0]!.index)}: ${steps[0]!.message}` });
  return { problems, steps };
}

/** The body that makes an automation: `POST /cron`, or `POST /webhooks` for one that starts when its address is called. */
export function createBody(draft: Draft): JobInput | WebhookInput {
  const body: WebhookInput = {
    agentId: draft.agentId,
    name: draft.name.trim(),
    payload: payloadOf(draft),
    target: { gatewayId: draft.gatewayId, chatId: draft.chatId.trim() },
    delivery: deliveryOf(draft),
  };
  if (draft.start === "webhook") return body;
  return { ...body, ...startBody(draft), ...(draft.start === "scheduled" && draft.trigger.mode === "once" && draft.keepAfterRun ? { keepAfterRun: true } : {}) };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A delivery's fields in one order: the same marks set in another order are the same delivery, and not a change to save. */
const ordered = (delivery: Delivery): [string, unknown][] => Object.entries(delivery).sort(([a], [b]) => a.localeCompare(b));

/** What a save sends for an automation that exists: each part that differs from what was loaded, and no other. */
export function patchBody(was: Draft, now: Draft): JobPatch {
  const patch: JobPatch = {};
  if (now.name.trim() !== was.name) patch.name = now.name.trim();
  if (!same(payloadOf(now), payloadOf(was))) patch.payload = payloadOf(now);
  if (now.start !== "webhook" && !same(startBody(now), startBody(was))) Object.assign(patch, startBody(now));
  if (now.gatewayId !== was.gatewayId || now.chatId.trim() !== was.chatId) patch.target = { gatewayId: now.gatewayId, chatId: now.chatId.trim() };
  if (!same(ordered(deliveryOf(now)), ordered(was.delivery))) patch.delivery = deliveryOf(now);
  if (sessionOf(now) !== was.session) patch.session = sessionOf(now);
  return patch;
}

export const changed = (was: Draft, now: Draft): boolean => Object.keys(patchBody(was, now)).length > 0;

/**
 * A draft after a change, with what becoming a list makes of it written out where a person sees it: the agent a lone
 * command woke is a step of its own from then on, drawn in the flow, and no longer a choice on the command.
 */
export function settled(draft: Draft): Draft {
  if (!savesAsList(draft) || draft.then !== "agentTurn") return draft;
  // The command that was the one thing, wherever a step added since has left it: the agent's step goes right after it.
  const first = draft.steps.findIndex((step) => step.kind === "command" && step.id === ONE);
  const lone = first >= 0 ? first : draft.steps.findIndex((step) => step.kind === "command");
  if (lone < 0) return { ...draft, then: "deliver" };
  const reads: Step = { id: newStepId(draft.steps), kind: "agentTurn", message: READS_OUTPUT };
  return { ...draft, steps: [...draft.steps.slice(0, lone + 1), reads, ...draft.steps.slice(lone + 1)], then: "deliver" };
}

/** What becoming a list changes besides the list itself, said before the save. Nothing for one that already was one. */
export function turnsIntoList(was: Draft | null, now: Draft): string[] {
  if (!was || savesAsList(was) || !savesAsList(now)) return [];
  const said: string[] = [];
  if (was.then === "agentTurn" && was.steps[0]?.kind === "command") said.push("Its command handed what it printed to the agent. That is a step of its own now, after the command.");
  if (was.session === "chat") said.push("It read its chat's history. With more than one step, each run starts clean instead.");
  return said;
}
