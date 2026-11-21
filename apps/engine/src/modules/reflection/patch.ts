/**
 * A revision as edits to the skill, not as the skill written again.
 *
 * The reviser used to return the whole improved body. Three things followed, all seen on a live box: a body near its
 * size limit went past it with every revision (43 of 64 refused drafts in fifteen days), a rewrite could drop a
 * procedure nobody had asked it to touch, and the answer cost the whole body in output each time. An edit names text
 * the skill holds and what replaces it: what is not named stays as it was, the body grows by the edit alone, and what
 * a person approves is the change.
 *
 * Pure. An edit that cannot be placed is a reason, said to the writer (`synthesis.ts` `handedBackOnce`); nothing is
 * half applied.
 */

export interface SkillEdit {
  /** Text the body holds, copied from it. */
  old: string;
  /** What replaces it. Empty removes it. */
  new: string;
}

/** The edits an answer carries: every entry with an `old` to find and a `new` of text. Anything else is left out. */
export function readEdits(raw: unknown): SkillEdit[] {
  if (!Array.isArray(raw)) return [];
  const edits: SkillEdit[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { old, new: replacement } = entry as Record<string, unknown>;
    if (typeof old !== "string" || typeof replacement !== "string" || !old.trim()) continue;
    edits.push({ old, new: replacement });
  }
  return edits;
}

/** Where `needle` is in `text`: each place it starts, with how much of the text it covers there. */
function places(text: string, needle: string): { at: number; length: number }[] {
  const found: { at: number; length: number }[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) found.push({ at, length: needle.length });
  return found;
}

/**
 * The same, read as a model copies: the spaces at a line's end, and around the whole, count for nothing. The place
 * and its length are the body's own, so the body's spaces (a markdown line break is two of them) are never touched.
 */
function placesLoosely(text: string, needle: string): { at: number; length: number }[] {
  const lines = needle.trim().split("\n").map((line) => line.replace(/[ \t]+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (lines.every((line) => !line)) return [];
  return [...text.matchAll(new RegExp(lines.join("[ \\t]*\\n"), "g"))].map((match) => ({ at: match.index, length: match[0].length }));
}

/**
 * The body with every edit made, in order, or why one could not be.
 *
 * `old` is found as written, then with the spaces at its lines' ends left out: a model copying a line loses those,
 * and refusing an edit for a space nobody can see would be the strictness this replaces. Found nowhere, or in more
 * than one place, it is refused by its number with what to do about it.
 */
export function patched(body: string, edits: readonly SkillEdit[]): { body: string } | { failed: string } {
  let text = body;
  for (const [index, edit] of edits.entries()) {
    const quoted = `"${edit.old.trim().split("\n")[0]!.slice(0, 60)}"`;
    const exact = places(text, edit.old);
    const found = exact.length > 0 ? exact : placesLoosely(text, edit.old);
    if (found.length === 0) return { failed: `edit ${index + 1}: its \`old\` text (${quoted}) is not in the skill. Copy it from the skill as it is written` };
    if (found.length > 1) return { failed: `edit ${index + 1}: its \`old\` text (${quoted}) is in the skill ${found.length} times. Copy more of the text around it, so it is found once` };
    const { at, length } = found[0]!;
    text = text.slice(0, at) + edit.new + text.slice(at + length);
  }
  return { body: text.trim() };
}
