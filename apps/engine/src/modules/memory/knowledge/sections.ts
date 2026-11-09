/**
 * A knowledge document cut into sections, the unit search finds and `memory_read` opens (0.8.20).
 *
 * Cut at headings, and again at paragraph breaks past `SECTION_MAX` characters, so a section is about one thing and
 * small enough to rank. Each carries its trail: the document's title and the headings above it, which go into the index
 * with its words, so "raised 3% on last year" is found by whose report and which year it sits under (Anthropic's
 * Contextual Retrieval measured that context; the title and trail are the part of it that costs no model).
 *
 * Pure.
 */

/** Characters past which a section is cut again at a paragraph break. A design value, set by the bench. */
const SECTION_MAX = 1_500;
/** Rows of a table per section: enough to answer from, few enough to rank. */
const ROWS_PER_SECTION = 200;

export interface Section {
  /** Its place in the document, from 0. */
  n: number;
  /** `Title › Heading › Subheading`. */
  trail: string;
  text: string;
  pageFrom?: number;
  pageTo?: number;
}

/** A trail's parts joined as a person reads them. */
export const TRAIL_MARK = " › ";

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** The text without a leading `---` frontmatter block: what a file's own metadata says is not what it says. */
function withoutFrontmatter(text: string): { body: string; frontmatter: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return match ? { body: text.slice(match[0].length), frontmatter: match[1] ?? "" } : { body: text, frontmatter: "" };
}

/**
 * A document's frontmatter `tags:` as written (0.8.23): a list on one line (`[ops, backups]`), one
 * per line (`- ops`), or words split by commas. What the memory graph joins it to, beside the conversations' tags.
 */
export function tagsOf(text: string): string[] {
  const { frontmatter } = withoutFrontmatter(text);
  const lines = frontmatter.split(/\r?\n/);
  const at = lines.findIndex((line) => /^tags:/.test(line));
  if (at < 0) return [];
  const inline = lines[at]!.slice("tags:".length).trim();
  const raw = inline
    ? inline.replace(/^\[|\]$/g, "").split(",")
    : lines.slice(at + 1).filter((_, i, rest) => rest.slice(0, i + 1).every((line) => /^\s*-\s/.test(line))).map((line) => line.replace(/^\s*-\s*/, ""));
  return raw.map((tag) => tag.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** A document's title: its frontmatter's `title`, its first heading, else the name it was given. */
export function titleOf(text: string, fallback: string): string {
  const { body, frontmatter } = withoutFrontmatter(text);
  const fromFront = /^title:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter)?.[1]?.trim();
  if (fromFront) return fromFront;
  let fenced = false;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = !fenced && HEADING.exec(line);
    if (heading) return heading[2]!.trim();
  }
  return fallback;
}

/** Paragraphs joined into pieces of at most `max` characters; a paragraph longer than that alone is cut at lines, then hard. */
function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n\s*\n/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    push();
    if (paragraph.length <= max) {
      current = paragraph;
      continue;
    }
    // One paragraph longer than a section: its lines, and a line longer than that in pieces of its own.
    for (const line of paragraph.split("\n")) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length <= max) current = next;
      else {
        push();
        for (let at = 0; at < line.length; at += max) {
          const part = line.slice(at, at + max);
          if (at + max >= line.length) current = part;
          else out.push(part);
        }
      }
    }
  }
  push();
  return out;
}

/** Markdown or plain text, cut at headings and then at paragraphs. Code fences are text: a `#` in one is no heading. */
export function sectionsOfText(text: string, title: string, max = SECTION_MAX): Section[] {
  const { body } = withoutFrontmatter(text.replace(/\r\n/g, "\n"));
  const blocks: { trail: string[]; lines: string[] }[] = [{ trail: [], lines: [] }];
  const headings: { level: number; text: string }[] = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = !fenced && HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
      headings.push({ level, text: heading[2]!.trim() });
      blocks.push({ trail: headings.map((h) => h.text), lines: [] });
      continue;
    }
    blocks[blocks.length - 1]!.lines.push(line);
  }
  const sections: Section[] = [];
  for (const block of blocks) {
    // The document's title is its first heading more often than not: said once.
    const trail = [title, ...(block.trail[0] === title ? block.trail.slice(1) : block.trail)].join(TRAIL_MARK);
    for (const piece of pieces(block.lines.join("\n"), max)) sections.push({ n: sections.length, trail, text: piece });
  }
  return sections;
}

/** A table (CSV) in sections of `ROWS_PER_SECTION` rows, each with the header row, so every section reads alone. */
export function sectionsOfTable(text: string, title: string, rows = ROWS_PER_SECTION): Section[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim());
  if (lines.length === 0) return [];
  const [header, ...body] = lines;
  // A table that fits one section needs no row range in its trail.
  if (body.length <= rows) return [{ n: 0, trail: title, text: lines.join("\n") }];
  const sections: Section[] = [];
  for (let at = 0; at < body.length; at += rows) {
    sections.push({ n: sections.length, trail: `${title}${TRAIL_MARK}rows ${at + 1} to ${Math.min(at + rows, body.length)}`, text: [header, ...body.slice(at, at + rows)].join("\n") });
  }
  return sections;
}
