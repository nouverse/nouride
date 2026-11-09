/**
 * The model's view of which tags mean one subject — asked only when a person ticks "Also ask the
 * model" in the tidy's preview, never at night, and never applied unseen (`tidy.ts`).
 *
 * The rules fold what is certainly one word; meaning beyond that — `cctv-setup` and `security-camera` —
 * is a judgement. So the model proposes groups, code checks each one and drops (not repairs) what
 * fails, and what survives is shown beside the rule changes, unticked, for a person to read.
 *
 * Pure: `memory-tags.ts` does the asking.
 */

import { oneLine } from "@nouride/shared";
import { extractJson } from "@/modules/llm/json-answer.ts";
import { normalizeTag } from "./tags.ts";
import type { TidyChange } from "./tidy.ts";

/** Once-used tags sent along, at most: the box's 501 fit, a vault four times larger is cut, newest kept. */
const ONCE_SENT = 400;
/** Room for the answer: a vault's worth of groups with their reasons, not the one conversation a pass call answers. */
export const SUGGEST_TOKENS = 4_000;

export interface Suggestions {
  changes: TidyChange[];
  /** Groups the model proposed that a check dropped, and which check — so "nothing" can be told from "nothing kept". */
  dropped: { from: string[]; into: string; why: string }[];
  /** False when the answer held no `groups` to read at all. */
  readable: boolean;
}
/**
 * A group merging two tags each this big is more often two subjects than one — but not always: two
 * spellings of one game can each gather twenty conversations. So it is flagged for a careful look, not
 * dropped; every suggestion is offered unticked anyway.
 */
const BIG = 20;

export function suggestPrompt(tags: readonly { tag: string; n: number }[]): { system: string; user: string } {
  const shared = tags.filter((entry) => entry.n >= 2);
  const once = tags.filter((entry) => entry.n === 1).slice(0, ONCE_SENT);
  return {
    system: [
      "You tidy the tags of an assistant's memory. Answer with one JSON object and nothing else:",
      '{"groups": [{"from": string[], "into": string, "reason": string}]}',
      "- A group is tags that mean the same subject: spellings, synonyms, a narrow tag that only ever means the broad one.",
      "- into: an existing tag wherever one fits; otherwise a new one, lowercase English, a word or two joined by '-'.",
      "- reason: a few words, for a person reading the list.",
      "- Leave distinct subjects apart, even when related: 'docker' and 'kubernetes' are two subjects. When unsure, leave it out.",
      "- Use [] when nothing should be merged.",
    ].join("\n"),
    user: [
      `Tags on two or more conversations, with how many: ${shared.map((entry) => `${entry.tag} (${entry.n})`).join(", ") || "(none)"}.`,
      `Tags on one conversation: ${once.map((entry) => entry.tag).join(", ") || "(none)"}.`,
    ].join("\n"),
  };
}

/**
 * The model's groups, checked: every tag named exists, `into` is a tag worth keeping, a group is 2–30
 * tags, and no tag is in two groups. A group that fails any of these is dropped whole, and said to be.
 * One that merges two tags each on 20+ conversations is kept with "Check first" before its reason.
 * Kept ones are tidy changes, why `model`.
 */
export function parseSuggestions(answer: string, counts: ReadonlyMap<string, number>): Suggestions {
  const parsed = extractJson(answer);
  const readable = Array.isArray(parsed?.groups);
  const groups = readable ? (parsed!.groups as unknown[]) : [];
  const used = new Set<string>();
  const changes: TidyChange[] = [];
  const dropped: Suggestions["dropped"] = [];
  for (const raw of groups) {
    const group = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const into = typeof group.into === "string" ? normalizeTag(group.into, new Map()) : null;
    const names = Array.isArray(group.from) ? group.from.filter((tag): tag is string => typeof tag === "string") : [];
    const from = [...new Set(names.map((tag) => normalizeTag(tag, new Map())).filter((tag): tag is string => tag !== null && tag !== into))];
    const why = (() => {
      if (!into) return "no tag to merge into";
      if (from.length < 1) return "nothing to merge";
      if (from.length + 1 > 30) return "more than 30 tags";
      const unknown = from.filter((tag) => !counts.has(tag));
      if (unknown.length) return `not in use: ${unknown.join(", ")}`;
      if (from.some((tag) => used.has(tag)) || used.has(into)) return "a tag already in another group";
      return null;
    })();
    if (why) {
      dropped.push({ from: names, into: typeof group.into === "string" ? group.into : "", why });
      continue;
    }
    from.forEach((tag) => used.add(tag));
    used.add(into!);
    const said = typeof group.reason === "string" ? oneLine(group.reason) : "";
    const big = [...from, into!].filter((tag) => (counts.get(tag) ?? 0) >= BIG).length >= 2;
    const reason = (big ? `Check first: two tags on ${BIG}+ conversations each, often two subjects. ${said}` : said).trim().slice(0, 140) || undefined;
    changes.push({ id: `model:${into}`, kind: "merge", from: from.sort(), into: into!, episodes: 0, why: "model", ...(reason ? { reason } : {}) });
  }
  return { changes, dropped, readable };
}
