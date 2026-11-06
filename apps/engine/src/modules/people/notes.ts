/**
 * A person's notes, changed one line at a time.
 *
 * Notes are a page the operator writes on the People page — who somebody is, in whatever shape they
 * like — and since `person_notes` the person can change their own through an agent. That second writer
 * is a model, and a model handed a page to rewrite rewrites all of it: a line it did not mean to touch
 * comes back reworded, or not at all. So an agent never sends the page. It sends one line to add, or the
 * line as it reads now and what it should read instead, and everything else stays exactly as it was —
 * the operator's headings, their order, their wording.
 *
 * Pure: the text in, the text out. Who may do this, and the write itself, are the caller's.
 */

/** One fact. Longer is a paragraph, and notes are read on every turn with them. */
const NOTE_LINE_MAX = 300;

/** What a line added by an agent may grow the notes to. The operator may write more on the People page. */
export const NOTES_MAX = 4000;

export type NotesChange =
  | { change: "add"; content: string; section?: string }
  | { change: "update"; current: string; content: string }
  | { change: "remove"; current: string };

export type NotesEdit =
  | {
      ok: true;
      notes: string;
      /** The line as it reads now; for a removal, what was removed. */
      line: string;
      /** For an update, the line as it read before. */
      was?: string;
      /** Nothing to do: the line was already there, or already read that way. */
      unchanged?: true;
    }
  | { ok: false; error: string; reason: "empty" | "too_long" | "full" | "not_found" | "ambiguous" };

// Two digits at most for a numbered item, so a line that opens with a year keeps it.
const MARKER = /^\s*(?:[-*+]|\d{1,2}[.)])\s+/;
const HEADING = /^(#{1,6})\s+(.*)$/;

const TOO_LONG = `One fact, one line, under ${NOTE_LINE_MAX} characters: notes are read on every turn with them.`;

/** A line's words: on one line, without its list marker. How lines are compared and how one is written. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(MARKER, "").trim();
}

function headingOf(line: string): { depth: number; text: string } | null {
  const match = line.trim().match(HEADING);
  return match ? { depth: match[1]!.length, text: match[2]!.trim() } : null;
}

/** The marker and indent a line is written with, so a changed line keeps its place in a list. */
function prefixOf(line: string): string {
  return line.match(MARKER)?.[0] ?? line.match(/^\s*/)?.[0] ?? "";
}

/** The next heading at or after `from`, of any depth, or the end. */
function nextHeading(lines: string[], from: number): number {
  for (let index = from; index < lines.length; index += 1) if (headingOf(lines[index]!)) return index;
  return lines.length;
}

/** After the last line with words in `[from, to)`, or `from` when there is none. */
function afterLast(lines: string[], from: number, to: number): number {
  for (let index = to - 1; index >= from; index -= 1) if (lines[index]!.trim()) return index + 1;
  return from;
}

/** Blank lines run together, none at either end. */
function tidy(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === "" && (out.length === 0 || out.at(-1) === "")) continue;
    out.push(trimmed);
  }
  while (out.at(-1) === "") out.pop();
  return out.join("\n");
}

/**
 * The line `current` names: the whole line word for word (then ignoring case), and failing that the one
 * line it is part of — notes written as one running line, as `person_record` and many operators write
 * them, change a sentence at a time.
 */
function find(lines: string[], current: string): number | { reason: "not_found" | "ambiguous"; error: string } {
  const content = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim() && !headingOf(line));
  const whole = content.find(({ line }) => flatten(line) === current);
  if (whole) return whole.index;
  const loose = content.filter(({ line }) => flatten(line).toLowerCase() === current.toLowerCase());
  if (loose.length === 1) return loose[0]!.index;
  const within = content.filter(({ line }) => flatten(line).includes(current));
  if (within.length === 1) return within[0]!.index;
  if (within.length > 1) {
    return {
      reason: "ambiguous",
      error: `"${current}" is in ${within.length} lines of their notes. Send the whole line, word for word:\n${within.map(({ line }) => `  ${line.trim()}`).join("\n")}`,
    };
  }
  return { reason: "not_found", error: `No line in their notes reads "${current}".` };
}

function add(notes: string, content: string, section: string | undefined): NotesEdit {
  const line = flatten(content);
  if (!line) return { ok: false, reason: "empty", error: "`content` is empty. Send the fact to add, as one line." };
  if (line.length > NOTE_LINE_MAX) return { ok: false, reason: "too_long", error: TOO_LONG };
  const lines = notes ? notes.split("\n") : [];
  if (lines.some((existing) => !headingOf(existing) && flatten(existing) === line)) return { ok: true, notes, line, unchanged: true };
  if (notes.length + line.length + 3 > NOTES_MAX) {
    return {
      ok: false,
      reason: "full",
      error: `Their notes are ${notes.length} characters already, and they are read on every turn with them. Update or remove a line instead.`,
    };
  }

  const item = `- ${line}`;
  const wanted = section?.replace(/^#+\s*/, "").trim();
  if (wanted) {
    const at = lines.findIndex((existing) => headingOf(existing)?.text.toLowerCase() === wanted.toLowerCase());
    if (at === -1) return { ok: true, line, notes: tidy([...lines, "", `## ${wanted}`, item]) };
    // Under the heading's own lines, above any heading nested in it.
    const end = afterLast(lines, at + 1, nextHeading(lines, at + 1));
    return { ok: true, line, notes: tidy([...lines.slice(0, end), item, ...lines.slice(end)]) };
  }

  // No heading named: with who they are, above the first heading — under it, it would read as that
  // section's.
  const first = nextHeading(lines, 0);
  const end = afterLast(lines, 0, first);
  const before = lines.slice(0, end);
  const gap = before.length > 0 && !MARKER.test(before.at(-1)!) ? [""] : [];
  return { ok: true, line, notes: tidy([...before, ...gap, item, "", ...lines.slice(end)]) };
}

function update(notes: string, current: string, content: string): NotesEdit {
  const line = flatten(content);
  if (!line) return { ok: false, reason: "empty", error: "`content` is empty. Send the line as it should read, or remove it instead." };
  if (line.length > NOTE_LINE_MAX) return { ok: false, reason: "too_long", error: TOO_LONG };
  const lines = notes.split("\n");
  const index = find(lines, current);
  if (typeof index !== "number") return { ok: false, ...index };
  const old = lines[index]!;
  const words = flatten(old);
  const whole = words === current || words.toLowerCase() === current.toLowerCase();
  // Part of a running line named, and the whole line sent back as it should read — the rest of it
  // is already in `content`, and splicing it in would say it twice.
  const rest = whole ? "" : words.replace(current, "").trim();
  const resent = rest.split(" ").length >= 2 && line.includes(rest);
  const next = `${prefixOf(old)}${whole || resent ? line : words.replace(current, line)}`;
  if (next === old) return { ok: true, notes, line: words, unchanged: true };
  lines[index] = next;
  const out = tidy(lines);
  if (out.length > NOTES_MAX && out.length > notes.length) {
    return { ok: false, reason: "full", error: `That would take their notes past ${NOTES_MAX} characters. Say it shorter.` };
  }
  return { ok: true, notes: out, line: flatten(next), was: words };
}

function remove(notes: string, current: string): NotesEdit {
  const lines = notes.split("\n");
  const index = find(lines, current);
  if (typeof index !== "number") return { ok: false, ...index };
  const old = lines[index]!;
  const words = flatten(old);
  const whole = words === current || words.toLowerCase() === current.toLowerCase();
  // The rest of a running line stays, unless only punctuation would.
  const rest = whole ? "" : words.replace(current, "").replace(/\s{2,}/g, " ").trim();
  if (/[\p{L}\p{N}]/u.test(rest)) {
    lines[index] = `${prefixOf(old)}${rest}`;
    return { ok: true, notes: tidy(lines), line: current };
  }
  lines.splice(index, 1);

  // Its heading goes with it when this was the last line under it — that heading only: one the
  // operator left empty on purpose is theirs.
  let owner = -1;
  for (let at = index - 1; at >= 0; at -= 1) {
    if (headingOf(lines[at]!)) {
      owner = at;
      break;
    }
  }
  if (owner !== -1 && afterLast(lines, owner + 1, nextHeading(lines, owner + 1)) === owner + 1) {
    const depth = headingOf(lines[owner]!)!.depth;
    const next = nextHeading(lines, owner + 1);
    // Not when a heading nested under it still has lines: it is the parent of something.
    const parent = next < lines.length && headingOf(lines[next]!)!.depth > depth;
    if (!parent) lines.splice(owner, 1);
  }
  return { ok: true, notes: tidy(lines), line: whole ? words : current };
}

/** One change to `notes`. A refusal says why, in words an agent can act on. */
export function editNotes(notes: string, change: NotesChange): NotesEdit {
  const text = notes.trim();
  if (change.change === "add") return add(text, change.content, change.section);
  const current = flatten(change.current);
  if (!current) return { ok: false, reason: "empty", error: "`current` is empty. Send the line as it reads now, word for word." };
  return change.change === "update" ? update(text, current, change.content) : remove(text, current);
}
