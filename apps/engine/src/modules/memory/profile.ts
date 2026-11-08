/**
 * A profile (`people/<key>.md`) and the shared file (`shared.md`): facts under headings, each saying
 * where it came from and who may read it — `docs/SPEC.md` §12.3.
 *
 * ```markdown
 * ---
 * type: person
 * name: Gading
 * ---
 *
 * ## Work
 * - Uses a MacBook Pro M3. ([[2026-09-20-1405-nix]]) {gading}
 * - The porch light goes off at 22:00. ([[2026-09-26-1310-nix]]) {gading, sam, in telegram:nouva:-1001}
 * ```
 *
 * The `{…}` list is the source conversation's audience — who took part, and the group chat it was in
 * — so the file alone decides who may read a fact, even after the episode is compacted or gone. A line
 * with no list was written by a person, not the nightly pass.
 *
 * Facts are addressed by number, in file order, the way the nightly pass is shown them: numbers are
 * stable for the length of one pass, which is all an operation needs.
 *
 * Pure.
 */

import { oneLine } from "@nouride/shared";
import { parseFront, renderFront, type Front } from "./frontmatter.ts";

/** Who took part in the conversation a fact came from, and the group chat when it was one. */
export interface Readers {
  people: string[];
  chat?: string;
}

export interface Fact {
  /** 1-based, in file order. */
  n: number;
  section: string;
  text: string;
  /** The episode it came from. */
  source?: string;
  readers?: Readers;
}

export type FactOperation =
  | { op: "add"; section: string; text: string }
  | { op: "update"; n: number; text: string }
  | { op: "remove"; n: number };

/**
 * Where an operation's result came from, stamped on the line it writes: the episode, and who may read
 * it. A fact told to a tool mid-conversation has readers but no episode yet.
 */
export interface Provenance {
  source?: string;
  readers: Readers;
}

const HEADING = /^##\s+(.+?)\s*$/;
const FACT = /^[-*]\s+(.*?)(?:\s+\(\[\[([^\]|]+)\]\]\))?(?:\s+\{([^}]*)\})?\s*$/;
/** Where a fact goes when a person or a model names no heading. */
const DEFAULT_SECTION = "Notes";

function renderReaders(readers: Readers): string {
  return `{${[...readers.people, ...(readers.chat ? [`in ${readers.chat}`] : [])].join(", ")}}`;
}

function parseReaders(raw: string): Readers {
  const readers: Readers = { people: [] };
  for (const item of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (item.startsWith("in ")) readers.chat = item.slice(3).trim();
    else readers.people.push(item);
  }
  return readers;
}

function renderFact(fact: { text: string; source?: string; readers?: Readers }): string {
  const text = oneLine(fact.text);
  return `- ${text}${fact.source ? ` ([[${fact.source}]])` : ""}${fact.readers ? ` ${renderReaders(fact.readers)}` : ""}`;
}

/** Every fact in a document body, numbered. Anything that is not a bullet under a heading is prose, and not a fact. */
export function factsOf(body: string): Fact[] {
  const facts: Fact[] = [];
  let section = DEFAULT_SECTION;
  for (const line of body.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    const match = FACT.exec(line);
    if (!match || !match[1]!.trim()) continue;
    facts.push({
      n: facts.length + 1,
      section,
      text: match[1]!.trim(),
      ...(match[2] ? { source: match[2] } : {}),
      ...(match[3] !== undefined ? { readers: parseReaders(match[3]) } : {}),
    });
  }
  return facts;
}

export interface ProfileText {
  front: Front;
  body: string;
}

export function readProfile(text: string): ProfileText {
  const parsed = parseFront(text);
  return parsed ?? { front: {}, body: text };
}

export function writeProfile(profile: ProfileText): string {
  return renderFront(profile.front, profile.body);
}

export interface ApplyResult {
  body: string;
  applied: FactOperation[];
  rejected: { operation: FactOperation; reason: string }[];
}

/** Which line each fact is on, by the number `factsOf` gives it. */
function numberedLines(lines: readonly string[]): { n: number; line: number }[] {
  const numbered: { n: number; line: number }[] = [];
  for (const [index, line] of lines.entries()) {
    if (HEADING.test(line)) continue;
    const match = FACT.exec(line);
    if (match && match[1]!.trim()) numbered.push({ n: numbered.length + 1, line: index });
  }
  return numbered;
}

/**
 * The body after a change: removed lines gone, blank runs folded, and a heading left with nothing under
 * it dropped — removing the last follow-up left an empty `## Follow-ups` in the profile for good.
 */
const tidy = (lines: readonly string[]) => {
  const kept = lines.filter((line) => line !== "\u0000");
  const emptied = kept.filter((line, index) => {
    if (!HEADING.test(line)) return true;
    const next = kept.slice(index + 1).find((after) => after.trim());
    return next !== undefined && !HEADING.test(next);
  });
  return `${emptied.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
};

/**
 * Apply operations to a body. Numbers refer to the facts before any of them ran, so a batch reads the
 * way the model wrote it; a number that names no fact, or a fact already changed in this batch, is
 * rejected rather than guessed at. An add whose text is already there is skipped as done.
 */
export function applyFacts(body: string, operations: readonly FactOperation[], provenance?: Provenance): ApplyResult {
  const lines = body.split("\n");
  const numbered = numberedLines(lines);
  const existing = new Set(factsOf(body).map((fact) => fact.text.toLowerCase()));
  const touched = new Set<number>();
  const additions = new Map<string, string[]>();
  const result: ApplyResult = { body, applied: [], rejected: [] };
  const stamp = provenance ? { ...(provenance.source ? { source: provenance.source } : {}), readers: provenance.readers } : {};

  for (const operation of operations) {
    if (operation.op === "add") {
      const text = oneLine(operation.text);
      if (!text) {
        result.rejected.push({ operation, reason: "an add with no text" });
        continue;
      }
      if (existing.has(text.toLowerCase())) continue;
      existing.add(text.toLowerCase());
      const section = operation.section.trim() || DEFAULT_SECTION;
      additions.set(section, [...(additions.get(section) ?? []), renderFact({ text, ...stamp })]);
      result.applied.push(operation);
      continue;
    }
    const target = numbered.find((entry) => entry.n === operation.n);
    if (!target) {
      result.rejected.push({ operation, reason: `no fact ${operation.n}` });
      continue;
    }
    if (touched.has(operation.n)) {
      result.rejected.push({ operation, reason: `fact ${operation.n} was already changed in this batch` });
      continue;
    }
    touched.add(operation.n);
    if (operation.op === "remove") lines[target.line] = "\u0000";
    else lines[target.line] = renderFact({ text: operation.text, ...stamp });
    result.applied.push(operation);
  }

  let out = lines.filter((line) => line !== "\u0000");
  for (const [section, added] of additions) out = insertUnder(out, section, added);
  result.body = tidy(out);
  return result;
}

/**
 * Replace facts by number, or drop them (`null`), each with its own source and readers — what
 * consolidation does, where one batch joins facts that came from different conversations. Every line
 * that is not one of these facts, prose a person wrote included, stays where it was.
 */
export function rewriteFacts(body: string, changes: ReadonlyMap<number, { text: string; source?: string; readers?: Readers } | null>): string {
  const lines = body.split("\n");
  for (const { n, line } of numberedLines(lines)) {
    if (!changes.has(n)) continue;
    const fact = changes.get(n);
    lines[line] = fact ? renderFact(fact) : "\u0000";
  }
  return tidy(lines);
}

/** Lines added at the end of a heading's facts, the heading created at the end when there is none. */
function insertUnder(lines: string[], section: string, added: string[]): string[] {
  const wanted = section.toLowerCase();
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1]?.toLowerCase() === wanted);
  if (start === -1) {
    const trimmed = [...lines];
    while (trimmed.length && !trimmed[trimmed.length - 1]!.trim()) trimmed.pop();
    return [...trimmed, ...(trimmed.length ? [""] : []), `## ${section}`, ...added];
  }
  let end = start + 1;
  while (end < lines.length && !HEADING.test(lines[end]!)) end += 1;
  let last = end;
  while (last > start + 1 && !lines[last - 1]!.trim()) last -= 1;
  return [...lines.slice(0, last), ...added, ...lines.slice(last)];
}

/** A body without the facts sourced from these episodes — what deleting a conversation does to the profiles it fed. */
export function withoutSources(body: string, sources: ReadonlySet<string>): { body: string; removed: number } {
  let removed = 0;
  const kept = body.split("\n").filter((line) => {
    const source = FACT.exec(line)?.[2];
    if (source && sources.has(source)) {
      removed += 1;
      return false;
    }
    return true;
  });
  return { body: kept.join("\n"), removed };
}
