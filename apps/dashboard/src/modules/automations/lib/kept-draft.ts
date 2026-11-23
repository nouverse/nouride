/**
 * An automation's unsaved changes, kept in this browser until they are saved or thrown away. Pure
 * (`tests/automation-kept-draft.test.ts`); `use-editor.ts` reads and writes them through `use-kept.ts`.
 *
 * Nothing on the automation's page is saved as it is typed, and nothing was kept either: a person who had drawn six
 * steps pressed "Automations" to look at another one, and came back to an empty page. So the draft is kept as it
 * changes, for the person who made it in the browser they made it in, and the page they left opens on it again.
 *
 * Per browser on purpose, as everything `use-kept.ts` holds: a draft is half a thought, not a record, and the daemon
 * has no row for an automation that does not exist yet. What a save needs from the server is never kept here: an
 * address another app is called at (`delivery.webhookUrl`) can hold that app's key, and stays where it is.
 *
 * A kept draft says what it was made from (`base`). An automation changed since by someone else, or by an agent's
 * suggestion taken, is shown as it is saved now, and the older changes are offered beside it: never put over it unasked.
 */

import type { Draft } from "./draft";
import type { Step } from "./steps";

/** The key of the one being made, among the ids of those that exist. No automation's id is this word. */
export const NEW = "new";
/** The most kept for one person: each can hold scripts, and a browser gives a page a few megabytes. The oldest go first. */
export const KEPT_MOST = 20;

export interface KeptDraft {
  draft: Draft;
  /** When it was last changed. */
  at: number;
  /** What it was made from: the automation as it was saved then (`baseOf`). */
  base: string;
}

export type KeptDrafts = Record<string, KeptDraft>;

/** One person's kept drafts in this browser. The `v1` is the shape of `Draft`: a build that changes it reads none of these. */
export const keptKey = (who: string): string => `nouride.automation-drafts.v1:${who}`;

/** A short mark of an automation as it is saved, to tell whether it changed since a draft was made from it. */
export function baseOf(loaded: Draft): string {
  const text = JSON.stringify(forKeeping(loaded));
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(36);
}

/** A draft as it is kept: without the address another app is called at, which can hold that app's key. */
export function forKeeping(draft: Draft): Draft {
  const { webhookUrl: _url, ...delivery } = draft.delivery;
  return { ...draft, delivery };
}

/** A kept draft as the page holds it again: the address it was kept without is the saved automation's own. */
export function restored(kept: Draft, loaded: Draft): Draft {
  return loaded.delivery.webhookUrl === undefined ? kept : { ...kept, delivery: { ...kept.delivery, webhookUrl: loaded.delivery.webhookUrl } };
}

const text = (value: unknown): value is string => typeof value === "string";
const thing = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a step read back is one the page can draw: its kind is known and what that kind is written in is there. */
function isStep(value: unknown): value is Step {
  if (!thing(value) || !text(value.id)) return false;
  switch (value.kind as Step["kind"]) {
    case "agentTurn":
      return text(value.message);
    case "command":
      return Array.isArray(value.argv) && value.argv.every(text) && (value.script === undefined || (thing(value.script) && text(value.script.text) && text(value.script.about)));
    case "systemEvent":
      return text(value.text);
    case "mission":
      return text(value.goal);
    case "approval":
      return text(value.ask);
    case "parallel":
      return Array.isArray(value.steps) && value.steps.every((part) => thing(part) && text(part.id) && (part.kind === "command" ? Array.isArray(part.argv) : part.kind === "agentTurn" && text(part.message)));
    // A kind this build does not know, as a later one may have written.
    default:
      return false;
  }
}

/** Whether what was read back is a draft the page can open: anything else is as if nothing had been kept. */
export function isDraft(value: unknown): value is Draft {
  if (!thing(value)) return false;
  const { trigger, delivery } = value;
  return (
    text(value.name) &&
    text(value.agentId) &&
    (value.start === "scheduled" || value.start === "webhook" || value.start === "manual") &&
    thing(trigger) &&
    text(trigger.mode) &&
    text(trigger.everyCount) &&
    text(trigger.everyUnit) &&
    text(trigger.time) &&
    Array.isArray(trigger.days) &&
    text(trigger.expr) &&
    text(trigger.at) &&
    text(trigger.tz) &&
    typeof value.keepAfterRun === "boolean" &&
    text(value.gatewayId) &&
    text(value.chatId) &&
    thing(delivery) &&
    text(delivery.mode) &&
    text(value.session) &&
    Array.isArray(value.steps) &&
    value.steps.every(isStep) &&
    text(value.then) &&
    typeof value.list === "boolean"
  );
}

export function isKeptDrafts(value: unknown): value is KeptDrafts {
  return thing(value) && Object.values(value).every((one) => thing(one) && typeof one.at === "number" && text(one.base) && isDraft(one.draft));
}

/** One person's kept drafts with one of them set, or taken out. Past the most kept, the oldest go. */
export function withKept(all: KeptDrafts, id: string, kept: KeptDraft | null): KeptDrafts {
  const { [id]: _was, ...rest } = all;
  if (!kept) return rest;
  const others = Object.entries(rest)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, KEPT_MOST - 1);
  return { ...Object.fromEntries(others), [id]: { ...kept, draft: forKeeping(kept.draft) } };
}

/** What the list says of one being made and not saved yet: its name, and how much of it there is. */
export function keptWords(kept: KeptDraft): { name: string; holds: string } {
  const count = kept.draft.steps.length;
  return { name: kept.draft.name.trim() || "No name yet", holds: count === 0 ? "No steps yet" : count === 1 ? "1 step" : `${count} steps` };
}
