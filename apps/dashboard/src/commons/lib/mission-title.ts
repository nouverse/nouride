/**
 * A mission's name, drawn wherever a mission is listed: its page, its card, and what waits for the person on Home and
 * Work, where the whole goal was a wall of large type.
 */

/** How long a mission's name may be before it is cut at a word. */
const TITLE_MAX = 90;

/**
 * A mission's name, from its goal: its first sentence, cut at a word near 90 characters. A goal is often a
 * paragraph — a job's run, an agent's own — and drawn whole as the page's title it was a wall of large type. The goal
 * itself is still on the page, and still what the search looks in.
 */
export function missionTitle(goal: string): string {
  const flat = goal.replace(/\s+/g, " ").trim();
  const first = /^.+?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  if (first.length <= TITLE_MAX) return first;
  const cut = first.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
