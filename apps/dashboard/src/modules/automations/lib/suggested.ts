/**
 * A change an agent suggested to an automation, read against the automation as it runs now: which steps it would add,
 * change and remove, and what else it would change. Pure (`tests/automation-suggested.test.ts`). Nothing here applies
 * anything: the change is the agent's until a person accepts it.
 *
 * Steps are matched by what they say, not by their ids. An agent that writes a list anew has its steps named by their
 * place, so a step put in at the second place gives every step after it a new id, and by id each of them would read
 * as changed when only one step was added. The matching itself is any list's (`changesBetween`): here a step's own
 * words are what it does, and where its paths lead is what else is said of it.
 *
 * Two changes are read with it: one an agent proposed to an automation that runs, which waits as an automation of its
 * own, and one it wrote to the draft a person has open, which waits on the page (`commons/lib/live-edit.ts`).
 */

import type { AutomationSummary } from "@nouride/wire";
import { changesBetween, type Mark } from "@/commons/lib/live-edit";
import { draftOf, type Draft } from "./draft";
import { EXITS, type Step } from "./steps";
import { describeDraft } from "./trigger";

export type { Mark };

/** A value with its keys in one order, so two steps that say the same are the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What a step does, less its id and where the run goes from it. */
function does(step: Step): string {
  const { id: _id, then: _then, whenFailed: _failed, whenEmpty: _empty, ...rest } = step;
  return canonical(rest);
}

/** Where the run goes from a step, each path by what the step it leads to does, so a renamed id is the same path. */
function goes(step: Step, steps: readonly Step[]): string {
  return EXITS.map((exit) => {
    const go = step[exit];
    if (go === undefined || typeof go === "string") return go ?? "";
    const target = steps.find((one) => one.id === go.to);
    return target ? `to:${does(target)}` : "to:";
  }).join("|");
}

/**
 * Each step's mark, by its id, in the list as it runs now (`current`: changed, removed) and in the suggested one
 * (`suggested`: added, changed). A step that does the same at the same place among the others has no mark, unless its
 * paths lead elsewhere. Of the rest, one that keeps its id and its kind is changed; what is left of the suggested
 * list is added, and what is left of the running one removed.
 */
export function stepMarks(current: readonly Step[], suggested: readonly Step[]): { current: Map<string, Mark>; suggested: Map<string, Mark> } {
  const marks = changesBetween(current, suggested, { id: (step) => step.id, does, kind: (step) => step.kind, also: goes });
  return { current: marks.before, suggested: marks.after };
}

const numbers = (places: number[]): string => (places.length === 1 ? `step ${places[0]}` : `steps ${places.slice(0, -1).join(", ")} and ${places.at(-1)}`);

/** How a draft starts, in words: a time, a call to its address, or a person. */
const startOf = (draft: Draft, home: string): string => (draft.start === "manual" ? "when you press Run now" : draft.start === "webhook" ? "when its address is called" : describeDraft(draft.trigger, home));

/**
 * What a change does to a draft, in a sentence or two, for the bar over the steps. `home`: the server's own time zone.
 * `now` is the automation as the page holds it, and `then` as the change would leave it.
 */
export function draftChangeWords(now: Draft, then: Draft, home: string): string {
  const marks = stepMarks(now.steps, then.steps);
  const at = (steps: readonly Step[], from: Map<string, Mark>, mark: Mark) => steps.flatMap((step, index) => (from.get(step.id) === mark ? [index + 1] : []));
  const [added, changed, removed] = [at(then.steps, marks.suggested, "added"), at(then.steps, marks.suggested, "changed"), at(now.steps, marks.current, "removed")];
  const said: string[] = [];
  if (added.length > 0) said.push(`Adds ${numbers(added)}.`);
  if (changed.length > 0) said.push(`Changes ${numbers(changed)}.`);
  if (removed.length > 0) said.push(`Removes ${numbers(removed)} of the ones it runs now.`);
  if (then.name !== now.name) said.push(`Renames it to "${then.name}".`);
  if (startOf(then, home) !== startOf(now, home)) said.push(`It would start ${startOf(then, home)}.`);
  if (then.agentId !== now.agentId) said.push("Another agent would run it.");
  // One with no chat picked yet reports nowhere: a change that names one does not move it to "another".
  if (then.gatewayId !== now.gatewayId || then.chatId !== now.chatId || then.delivery.gatewayId !== now.delivery.gatewayId || then.delivery.chatId !== now.delivery.chatId) {
    said.push(now.chatId.trim() ? "It would report to another chat." : "It would report to the chat shown under its steps.");
  }
  // The two marks where it reports: a change that sets or drops one is not one that runs as it does now.
  if (Boolean(then.delivery.once) !== Boolean(now.delivery.once)) said.push(then.delivery.once ? "It would tell once, then turn itself off." : "It would go on telling, and no longer turn itself off.");
  if (Boolean(then.delivery.atOnce) !== Boolean(now.delivery.atOnce)) said.push(then.delivery.atOnce ? "It would tell at once, even in quiet hours." : "What it says in quiet hours would be kept until they end.");
  if (then.delivery.lasts !== now.delivery.lasts) said.push(then.delivery.lasts === undefined ? "It would have no end." : "How long it lasts would change.");
  return said.length > 0 ? said.join(" ") : "It would run as it does now.";
}

/** What a change an agent proposed to an automation that runs does: the same words, of the two as the server holds them. */
export function changeWords(current: AutomationSummary, suggested: AutomationSummary, home: string): string {
  return draftChangeWords(draftOf(current, home), draftOf(suggested, home), home);
}

/**
 * The steps of a change that hold a script the draft did not hold as it is: a new one, or one whose text differs, by
 * its place in the changed list. What a person reads before they apply: a script is a program, and it is the one part
 * of a change whose words say less than its text.
 */
export function scriptsBrought(now: Draft, then: Draft): number[] {
  const texts = new Set(now.steps.flatMap((step) => (step.kind === "command" && step.script ? [step.script.text] : [])));
  return then.steps.flatMap((step, index) => (step.kind === "command" && step.script && !texts.has(step.script.text) ? [index + 1] : []));
}
