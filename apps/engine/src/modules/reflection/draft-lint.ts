/**
 * What a drafted skill may not be, checked in code — the prompts ask for the same, and asking was not enough.
 *
 * Measured on the x64 box by 2026-10-22: 31 drafts, every one approved under `[rsi] mode = "always_allow"`. `home-pc-ops` had grown
 * to 306 lines of incidents, a skill named one audit workbook, descriptions read "Update deployment-docker to target
 * LXC 105…", and machines' addresses sat in procedures every agent was handed. Each of those is something the prompts
 * already said not to do.
 *
 * Pure. A refusal is the reason, said where the pass logs it; nothing is half-kept.
 */

/** A new skill's body. Past it, the detail goes to `references/`. */
export const NEW_BODY_CHARS = 8_000;
/** A revised body's. One already past it may be revised only into one no longer than it was. */
export const BODY_CHARS = 12_000;

/** Addresses that name no machine of anybody's: loopback, any, and the documentation ranges (RFC 5737). */
const NOT_A_MACHINE = /^(?:127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|255\.255\.255\.)/;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const MAC = /\b[0-9A-F]{2}(?::[0-9A-F]{2}){5}\b/i;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
/** `example.com` and its kind are placeholders (RFC 2606), not anybody's account. */
const PLACEHOLDER_DOMAIN = /@(?:[\w-]+\.)*example\.(?:com|org|net)$/i;
/**
 * A description written as the change that was made — "Update deployment-docker to target…", "Document that…" — rather
 * than when to use the skill. It is matched against every future task, so a note about an edit matches none of them.
 */
const EDIT_NOTE = /^(?:update[sd]?|add(?:s|ed)?|document(?:s|ed)?|capture[sd]?|clarif(?:y|ies|ied)|record(?:s|ed)?|note[sd]?)\b/i;
/** A session told rather than a procedure written: "in this session", "the user said". */
const STORY = /\b(?:this|that|the previous|the last) (?:session|conversation)\b|\bthe user (?:said|asked|wanted|corrected|pushed back|confirmed|insisted)\b/i;

/** What in a body is not procedure — an address, an account, a session told — said as a reason, or null. */
export function notAProcedure(body: string): string | null {
  const address = [...body.matchAll(IPV4)].map((match) => match[0]).find((ip) => !NOT_A_MACHINE.test(ip));
  if (address) return `it names a machine's address (${address}). Facts about this environment belong in memory`;
  if (MAC.test(body)) return "it names a hardware address. Facts about this environment belong in memory";
  const email = [...body.matchAll(EMAIL)].map((match) => match[0]).find((found) => !PLACEHOLDER_DOMAIN.test(found));
  if (email) return `it names an account (${email}). Facts about this environment belong in memory`;
  const story = STORY.exec(body);
  if (story) return `it tells a session ("${story[0]}") rather than writing the procedure`;
  return null;
}

/** Why this draft may not be written, or null. `previousBody` is the skill's body before a revision; absent for a new one. */
export function draftRefusal(draft: { description: string; body: string; previousBody?: string; descriptionChanged: boolean }): string | null {
  if (draft.descriptionChanged && EDIT_NOTE.test(draft.description.trim())) {
    return `its description says what was changed, not when to use it: "${draft.description.slice(0, 80)}"`;
  }
  const fact = notAProcedure(draft.body);
  if (fact) return fact;

  // A body already past the limit may be revised only into one no longer than it was: tightened, never extended.
  const limit = draft.previousBody === undefined ? NEW_BODY_CHARS : Math.max(BODY_CHARS, draft.previousBody.length);
  if (draft.body.length > limit) {
    const chars = (n: number) => n.toLocaleString("en-US");
    return draft.previousBody !== undefined && limit > BODY_CHARS
      ? `it grows a body already past ${chars(BODY_CHARS)} characters (${chars(draft.previousBody.length)} → ${chars(draft.body.length)}). A revision past the limit must tighten it`
      : `its body is ${chars(draft.body.length)} characters, past ${chars(limit)}. The detail belongs in references/`;
  }
  return null;
}
