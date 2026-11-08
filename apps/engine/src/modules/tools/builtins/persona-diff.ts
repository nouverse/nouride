/**
 * What a persona change shows the person deciding it (0.8.8): the lines it takes out and puts in, against the file as it
 * stands — not the whole file, and not the old one beside the new one.
 *
 * The preview every other write gets is read off the arguments' shape (`buildApprovalPreview`): a whole file is "replaces
 * 40 lines with 41", which says nothing of the one rule that changed, and an edit's hunk is the old text, then the new.
 * A persona is where one changed line matters — the line that asks before a push — so the change is found line by line.
 *
 * It runs in the tool's gate, on the daemon's event loop, before anyone is asked: every step is linear in the file but
 * the comparison, which is bounded (`MAX_CELLS`), and a change too large to show is refused on its raw size before a
 * line of it is labelled, and on what it would show before a line of that is built. Labelling every changed line
 * first made one 512 KiB call hold the daemon for minutes.
 */

import { type ApprovalPreview, type DiffLine, plural } from "@nouride/shared";

/**
 * The most a persona change may change at once: what a chat's prompt shows whole beside its question and buttons. Never
 * clipped, as other previews are: in 0.8.8 a rule changed past a line's 200th character, or removed after
 * the 24th changed line, was approved by an admin who was never shown it. A larger change goes a section at a time.
 */
const MAX_LINES = 24;
const MAX_CHARS = 2_400;
/** Compared line by line up to this many pairs of lines; past it, every line between the common head and tail is said changed. */
const MAX_CELLS = 1_000_000;

/** A changed line: taken out of the old file or put into the new, by its index there. */
interface Change {
  sign: "-" | "+";
  at: number;
}

/** A line both files have, by its index in each: it may sit under another heading in the new one. */
interface Kept {
  sign: "=";
  from: number;
  to: number;
}

/**
 * The two files line by line, in order: each line taken out, put in, or kept — by index. Kept lines are in it because a
 * line can change its place without changing its text: a heading moved up over two rules took them under "Free to do
 * without asking" with only the heading shown.
 */
function compare(a: readonly string[], b: readonly string[]): (Change | Kept)[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const rows = endA - start;
  const cols = endB - start;
  const out = (at: number): Change => ({ sign: "-", at: start + at });
  const into = (at: number): Change => ({ sign: "+", at: start + at });
  const kept = (from: number, to: number): Kept => ({ sign: "=", from, to });
  const each = (count: number, from = 0) => Array.from({ length: count - from }, (_, k) => from + k);
  const head = each(start).map((at) => kept(at, at));
  const tail = each(a.length - endA).map((k) => kept(endA + k, endB + k));
  if (rows * cols > MAX_CELLS) return [...head, ...each(rows).map(out), ...each(cols).map(into), ...tail];

  // The longest common subsequence from each pair onwards; the walk keeps what both share and says the rest.
  const width = cols + 1;
  const common = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      common[i * width + j] = a[start + i] === b[start + j] ? common[(i + 1) * width + j + 1]! + 1 : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }
  const found: (Change | Kept)[] = [...head];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[start + i] === b[start + j]) found.push(kept(start + i++, start + j++));
    else if (common[(i + 1) * width + j]! >= common[i * width + j + 1]!) found.push(out(i++));
    else found.push(into(j++));
  }
  return [...found, ...each(rows, i).map(out), ...each(cols, j).map(into), ...tail];
}

/** An ATX heading, indented up to three spaces as markdown allows. */
const HEADING = /^ {0,3}(#{1,6})(?:\s+\S|\s*$)/;
/** A line that is only a bold label — `**Behavior:**`, `__Behavior__` — which groups the rules under it as a heading does. */
const BOLD_LABEL = /^(\*\*|__)[^*_]+\1:?$/;
const FENCE = /^\s*(?:```|~~~)/;
/**
 * A line that changes where the lines after it sit in a way the places are not read from: a code fence — one added line,
 * left open, turned every heading after it into code, and a rule moved under "Free to do" still read as under "Ask
 * first" — a heading's underline, an HTML heading. The owner changes a file's structure on the
 * Files tab; a proposal that changes one of these is refused. An HTML comment's opening marker, and the tags that hide
 * what they wrap, anywhere in a line, too: the rules between them are kept, and would not be shown. Its closing marker
 * is `COMMENT_END`.
 */
const STRUCTURE =
  /^\s*(?:```|~~~)|^\s*(?:=+|-{2,})\s*$|<!--|<\/?(?:h[1-6]|details|summary|div|span|p|template|style|script|noscript|iframe|object|section|font|small|del|s|strike|ins)\b[^>]*>/i;
/**
 * `-->` ends an HTML comment, which only a file holding `<!--` has: there it could close one early and bring the rules
 * after it into view, and is refused; anywhere else it is an arrow in prose — `draft --> review` — refused for
 * nothing. A changed line cannot open a comment (`STRUCTURE`), so the file as it stands decides.
 */
const COMMENT_END = "-->";
/** A list item, by its indent: the items above it with less indent are what it sits under. */
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+\S/;
/** A plain line that labels what follows it — `Ask Sam first:` — as a bold label does. */
const PLAIN_LABEL = /^\S.*:$/;
/** A list item that labels the items after it at its own indent — `- Free to do:`, `- **Free to do:**`. */
const LABEL_ITEM = /^(?:[-*+]|\d+[.)])\s+.*:(?:\*\*|__)?$/;
/** A table's delimiter row — `|---|:--:|` — under its header row; a line of dashes alone is a rule or an underline. */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Where a line sits: as the admin is shown it, all of that but the list items it is under, and those items by index. */
interface Place {
  shown: string;
  outer: string;
  items: number[];
}

/** A list item a line can sit under: its indent, its text, and its index in the file. */
interface Item {
  indent: number;
  text: string;
  at: number;
}

/**
 * Where each line of a file sits, in one pass: the `#` headings above it, as a path, the bold label and the plain `…:`
 * label since the last of them, the header row of the table it is a row of, and the list items it is nested under — a
 * line inside a fenced block is never one. In a rules file, where a line is decides what it means: a rule moved from "Ask
 * Sam first, always" to "Free to do without asking" read as the same line taken out and put back; the path keeps a
 * `### Git` under each of two parents apart, a `SOUL.md` groups its rules by bold labels, a section may group them by a
 * plain label line or a list item ending in a colon, over rules nested under it or beside it at its own indent, and a
 * table's columns say what a row's cells mean. `]` in a label is escaped: it would close the label.
 */
function placesOf(lines: readonly string[]): Place[] {
  const path: string[] = [];
  let bold: string | null = null;
  let plain: string | null = null;
  let table: string | null = null;
  let items: Item[] = [];
  let flat: Item | null = null;
  let fenced = false;
  let previous = "";
  return lines.map((line, at) => {
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    const item = LIST_ITEM.test(line);
    // A label item heads the items after it at its indent — not itself, nor the next label item beside it, which the
    // place of `- **Free to do:**` showed under `- Ask Sam first:`.
    const labelled = flat !== null && indent >= flat.indent && !(item && indent === flat.indent && LABEL_ITEM.test(text));
    // Outermost first: the items the label item is nested in, the label item, then the items it heads — a label nested in
    // a label read inside out, put after every item.
    const parents = items.filter((parent) => parent.indent < indent && parent !== flat);
    const under = labelled ? [...parents.filter((parent) => parent.indent < flat!.indent), flat!, ...parents.filter((parent) => parent.indent >= flat!.indent)] : parents;
    const outer = [...path.filter(Boolean), ...(bold ? [bold] : []), ...(plain ? [plain] : []), ...(table ? [table] : [])];
    const shown = [...outer, ...under.map((parent) => parent.text)].join(" › ") || "top of the file";
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) {
      const heading = HEADING.exec(line);
      const level = heading ? heading[1]!.length : 0;
      // A table's rows sit under its header row until a line that is not one of them.
      if (TABLE_RULE.test(line) && line.includes("|") && previous.includes("|")) table = previous.trim();
      else if (table && (!line.includes("|") || heading || item)) table = null;
      if (heading) {
        path.length = level - 1;
        path[level - 1] = text;
        bold = plain = flat = table = null;
        items = [];
      } else if (BOLD_LABEL.test(text)) {
        bold = text;
        plain = flat = table = null;
        items = [];
      } else if (item) {
        items = [...items.filter((parent) => parent.indent < indent), { indent, text, at }];
        if (LABEL_ITEM.test(text)) flat = items.at(-1)!;
        else if (flat && indent < flat.indent) flat = null;
      } else if (text && indent === 0) {
        // A paragraph ends the list above it; one ending in a colon labels what follows.
        items = [];
        flat = null;
        if (PLAIN_LABEL.test(text)) plain = text;
      }
    }
    previous = line;
    return { shown: shown.replace(/\]/g, "\\]"), outer: outer.join(" › "), items: under.map((parent) => parent.at) };
  });
}

/**
 * The change as the admin reads it — each changed line under where it sits in its own file, the old one for a line taken
 * out, the new one for a line put in, and each line under a list item reworded where it stands once, as it is — or why it
 * is too large to put in front of an admin whole: refused on its raw size before any line is labelled, and on what it
 * would show before a line of that is built.
 */
export function personaChange(before: string, after: string): DiffLine[] | { refused: string } {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines = compare(a, b);
  const found = lines.filter((line): line is Change => line.sign !== "=");
  const text = (change: Change) => (change.sign === "-" ? a : b)[change.at]!;
  const tooLarge = (lines: number, chars: number) =>
    `this change shows ${lines} ${plural(lines, "line")} and ${chars} characters, and an admin is shown every line of it whole, with where it sits: ` +
    `at most ${MAX_LINES} lines and ${MAX_CHARS} characters at once. Propose it a section at a time`;
  const raw = found.reduce((sum, change) => sum + text(change).length, 0);
  if (found.length > MAX_LINES || raw > MAX_CHARS) return { refused: tooLarge(found.length, raw) };
  const opensComment = before.includes("<!--");
  const structural = found.find((change) => STRUCTURE.test(text(change)) || (opensComment && text(change).includes(COMMENT_END)));
  if (structural) {
    return {
      refused:
        `a changed line, "${text(structural).trim()}", holds a code fence, a heading's underline, an HTML comment marker (\`<!--\`, ` +
        "or `-->` in a file with a comment) or an HTML tag that hides or heads what it wraps. It changes where every line after " +
        "it sits, or what is seen. The owner changes a file's structure on the Files tab: propose the change without it",
    };
  }
  const placesA = placesOf(a);
  const placesB = placesOf(b);
  // Each line taken out and put in by where it stands: the stretch between two kept lines, and its order in it.
  const slotA = new Map<number, string>();
  const slotB = new Map<number, string>();
  let gap = 0;
  let outs = 0;
  let ins = 0;
  for (const line of lines) {
    if (line.sign === "=") {
      gap += 1;
      outs = ins = 0;
    } else if (line.sign === "-") slotA.set(line.at, `${gap}:${outs++}`);
    else slotB.set(line.at, `${gap}:${ins++}`);
  }
  /**
   * A kept line under a list item reworded where it stands — the item taken out and the one put in at the same place in a
   * run of changed lines: a wrapped rule's later lines, a rule nested under it — is shown once, as it is, after the item's
   * new line, rather than taken out and put back with each wording of the item in its place: a long rule's first line
   * reworded repeated it on every line after it and went over what an admin is shown. A line now under another
   * item — one that stays, or one put in at another place — is still shown out of one and into the other, by name.
   */
  const reworded = (from: Place, to: Place) =>
    from.outer === to.outer &&
    from.items.length === to.items.length &&
    from.items.every((x, k) => {
      const y = to.items[k]!;
      return a[x]!.trim() === b[y]!.trim() || (slotA.has(x) && slotA.get(x) === slotB.get(y));
    });
  // What a line is shown as, given to `emit`: in a first pass that only counts, so a change too large is refused before
  // a line of it is built, then in the one that builds it.
  const visit = (line: Change | Kept, emit: (sign: DiffLine["sign"], place: string | null, text: string) => void) => {
    if (line.sign !== "=") return emit(line.sign, (line.sign === "-" ? placesA : placesB)[line.at]!.shown, text(line));
    const from = placesA[line.from]!;
    const to = placesB[line.to]!;
    if (from.shown === to.shown) return;
    if (reworded(from, to)) return emit(" ", null, b[line.to]!);
    emit("-", from.shown, a[line.from]!);
    emit("+", to.shown, b[line.to]!);
  };
  let count = 0;
  let chars = 0;
  const measure = (_sign: DiffLine["sign"], place: string | null, line: string) => {
    count += 1;
    chars += (place === null ? 0 : place.length + 3) + line.length;
  };
  for (const line of lines) visit(line, measure);
  if (count > MAX_LINES || chars > MAX_CHARS) return { refused: tooLarge(count, chars) };
  const shown: DiffLine[] = [];
  const build = (sign: DiffLine["sign"], place: string | null, line: string) => {
    shown.push({ sign, text: place === null ? line : `[${place}] ${line}` });
  };
  for (const line of lines) visit(line, build);
  return shown;
}

/** The change as an approval shows it: every line added and taken out, whole, and the lines kept that it shows. */
export function personaPreview(file: string, lines: readonly DiffLine[], against?: string): ApprovalPreview {
  return {
    kind: "edit",
    path: file,
    added: lines.filter((line) => line.sign === "+").length,
    removed: lines.filter((line) => line.sign === "-").length,
    hunk: [...lines],
    clipped: false,
    ...(against ? { against } : {}),
  };
}
