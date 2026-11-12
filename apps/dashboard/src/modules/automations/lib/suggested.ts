/**
 * A change an agent suggested to an automation, read against the automation as it runs now: which steps it would add,
 * change and remove, and what else it would change. Pure (`tests/automation-suggested.test.ts`). Nothing here applies
 * anything: the change is the agent's until a person accepts it.
 *
 * Steps are matched by what they say, not by their ids. An agent that writes a list anew has its steps named by their
 * place, so a step put in at the second place gives every step after it a new id, and by id each of them would read
 * as changed when only one step was added.
 */

import type { AutomationSummary } from "@nouride/wire";
import { stepsOf } from "./draft";
import { EXITS, type Step } from "./steps";
import { startWords } from "./trigger";

export type Mark = "added" | "changed" | "removed";

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

/** The longest run of steps that do the same in both lists, in order: each pair of places that match. */
function matched(a: readonly string[], b: readonly string[]): [number, number][] {
  const longest: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) longest[i]![j] = a[i] === b[j] ? longest[i + 1]![j + 1]! + 1 : Math.max(longest[i + 1]![j]!, longest[i]![j + 1]!);
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (longest[i + 1]![j]! >= longest[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
}

/**
 * Each step's mark, by its id, in the list as it runs now (`current`: changed, removed) and in the suggested one
 * (`suggested`: added, changed). A step that does the same at the same place among the others has no mark, unless its
 * paths lead elsewhere. Of the rest, one that keeps its id and its kind is changed; what is left of the suggested
 * list is added, and what is left of the running one removed.
 */
export function stepMarks(current: readonly Step[], suggested: readonly Step[]): { current: Map<string, Mark>; suggested: Map<string, Mark> } {
  const marks = { current: new Map<string, Mark>(), suggested: new Map<string, Mark>() };
  const pairs = matched(current.map(does), suggested.map(does));
  const [seenNow, seenThen] = [new Set(pairs.map(([i]) => i)), new Set(pairs.map(([, j]) => j))];
  for (const [i, j] of pairs) {
    if (goes(current[i]!, current) === goes(suggested[j]!, suggested)) continue;
    marks.current.set(current[i]!.id, "changed");
    marks.suggested.set(suggested[j]!.id, "changed");
  }
  suggested.forEach((step, j) => {
    if (seenThen.has(j)) return;
    const i = current.findIndex((one, at) => !seenNow.has(at) && one.id === step.id && one.kind === step.kind);
    if (i < 0) return void marks.suggested.set(step.id, "added");
    seenNow.add(i);
    marks.current.set(current[i]!.id, "changed");
    marks.suggested.set(step.id, "changed");
  });
  current.forEach((step, i) => {
    if (!seenNow.has(i)) marks.current.set(step.id, "removed");
  });
  return marks;
}

const numbers = (places: number[]): string => (places.length === 1 ? `step ${places[0]}` : `steps ${places.slice(0, -1).join(", ")} and ${places.at(-1)}`);

/** What the change does, in a sentence or two, for the banner over the steps. `home`: the server's own time zone. */
export function changeWords(current: AutomationSummary, suggested: AutomationSummary, home: string): string {
  const [now, then] = [stepsOf(current.payload), stepsOf(suggested.payload)];
  const marks = stepMarks(now, then);
  const at = (steps: readonly Step[], from: Map<string, Mark>, mark: Mark) => steps.flatMap((step, index) => (from.get(step.id) === mark ? [index + 1] : []));
  const [added, changed, removed] = [at(then, marks.suggested, "added"), at(then, marks.suggested, "changed"), at(now, marks.current, "removed")];
  const said: string[] = [];
  if (added.length > 0) said.push(`Adds ${numbers(added)}.`);
  if (changed.length > 0) said.push(`Changes ${numbers(changed)}.`);
  if (removed.length > 0) said.push(`Removes ${numbers(removed)} of the ones it runs now.`);
  if (suggested.name !== current.name) said.push(`Renames it to "${suggested.name}".`);
  if (startWords(suggested.trigger, home) !== startWords(current.trigger, home)) said.push(`It would start ${startWords(suggested.trigger, home)}.`);
  if (suggested.target.gatewayId !== current.target.gatewayId || suggested.target.chatId !== current.target.chatId) said.push("It would report to another chat.");
  return said.length > 0 ? said.join(" ") : "It would run as it does now.";
}
