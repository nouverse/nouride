/**
 * Text cut and flattened for a line a person or a model reads: one copy of each rule.
 *
 * Each was written again wherever it was needed, alike but for an off-by-one or a `trimEnd`, so one cut ran a
 * character past its budget and the next did not. Where two copies genuinely differed they are two names here, or a
 * parameter that says the difference (`clip`'s `keep`), and every caller kept the result it had. `apps/dashboard` and
 * the `ui-*` packages keep their own: they import no workspace package but the browser's (ARCHITECTURE.md §3).
 */

/** Every run of whitespace, line breaks included, as one space, and none at either end. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Each line break, with the spaces around it, as one space, and none at either end. The spaces inside a line are kept:
 * a model's reasoning or a Markdown link's text is joined, not reflowed.
 */
export function joinLines(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * `text` as it is when it fits in `max` characters; past that, its first `keep` characters and a "…". `keep` is
 * `max - 1` unless said, so the "…" is inside the budget and a cut line is never longer than an uncut one. A caller that
 * keeps `max` characters and puts the "…" after them says `keep = max`.
 */
export function clip(text: string, max: number, keep = max - 1): string {
  return text.length > max ? `${text.slice(0, keep)}…` : text;
}

/** As `clip`, without the space a cut can leave before the "…": "two words…", not "two words …". */
export function clipTrimmed(text: string, max: number, keep = max - 1): string {
  return text.length > max ? `${text.slice(0, keep).trimEnd()}…` : text;
}

/**
 * `text` in at most `max` characters, the "…" included, cut at a word. Cut at the last space, unless that space comes
 * before `floor`: one long word (a URL, a path) would leave almost nothing, so it is cut where the room ends instead.
 */
export function cutAtWord(text: string, max: number, floor = Math.floor(max / 2)): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= floor ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/**
 * How much of an elided line is kept from its end: a third. `ssh -i <a key path> -o ConnectTimeout=5 host uptime`
 * spends its budget on the key and the flags, and what a person wants, which host and running what, is at the end.
 */
const TAIL_SHARE = 1 / 3;

/**
 * A line too long to show with its middle cut out, both ends kept: in at most `max` characters, the "…" included. One
 * rule for every step a person watches: a cap with no marker and a second one that kept the tail once ran one after
 * the other, and the tail never survived.
 */
export function elide(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const tail = Math.floor(keep * TAIL_SHARE);
  const head = keep - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** The words a model reads where `keepEnds` left a middle out. */
const LEFT_OUT = (left: number) => `[… ${left} characters left out …]`;

/**
 * A long text's head and tail, half of `max` each, on either side of a line saying how much was left out between: the
 * start of a pasted log or a command says what it was, and its end how it went. `mark` words that line.
 */
export function keepEnds(text: string, max: number, mark: (left: number) => string = LEFT_OUT): string {
  if (text.length <= max) return text;
  const keep = Math.floor(max / 2);
  return `${text.slice(0, keep)}\n${mark(text.length - max)}\n${text.slice(text.length - keep)}`;
}

/** The word for `count` of something: `one` for exactly one, else `many`, which is `one` and an "s" unless said. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}
