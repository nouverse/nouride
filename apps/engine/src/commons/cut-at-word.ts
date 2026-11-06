/**
 * Text shortened for a line a person reads: cut at a word, with "…" where it was cut.
 *
 * One copy. A skill's announcement cut its reason at 200 characters mid-word ("…before it was rig"), and the prompt's
 * skill list, the peer lines and the morning line each carried their own cut at a word, alike but for the numbers.
 */

/**
 * `text` in at most `max` characters, the "…" included. Cut at the last space, unless that space comes before
 * `floor`: one long word (a URL, a path) would leave almost nothing, so it is cut where the room ends instead.
 */
export function cutAtWord(text: string, max: number, floor = Math.floor(max / 2)): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= floor ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}
