/**
 * The two ways a memory file is edited by hand or by a tool: add a block, or rewrite one heading.
 *
 * Moved here from `tools/builtins/memory.ts` when memory grew files outside the pack — a profile, a
 * topic — that are edited the same way as `MEMORY.md`. One implementation, so a heading matched in
 * one file is matched the same way in every other.
 *
 * Pure.
 */

/** `content` as a new block at the end. */
export function appendBlock(existing: string, content: string): string {
  return existing.trimEnd() ? `${existing.trimEnd()}\n\n${content.trim()}\n` : `${content.trim()}\n`;
}

/** A heading line's depth and text, or null when the line is not one. */
function headingOf(line: string): { depth: number; text: string } | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  return match ? { depth: match[1]?.length ?? 0, text: match[2]?.trim() ?? "" } : null;
}

/** A section name as it is matched: without its `#`s, case ignored. */
const wantedOf = (section: string) => section.replace(/^#+\s*/, "").trim().toLowerCase();

/** The heading `content` opens with — `Hardware` for a section sent whole as `## Hardware\n…` — or null. */
export function leadingHeading(content: string): string | null {
  return headingOf(content.trim().split("\n")[0] ?? "")?.text || null;
}

/** Whether `source` has a heading reading `section`, matched the way `replaceSection` matches it. */
export function hasSection(source: string, section: string): boolean {
  const wanted = wantedOf(section);
  return source.split("\n").some((line) => headingOf(line)?.text.toLowerCase() === wanted);
}

/**
 * Replace a heading's body, up to the next heading at the same or shallower depth. Null when no
 * heading matches.
 *
 * "Same or shallower" is what makes nested content behave: rewriting `## Preferences` should take its
 * `###` subsections with it, but must stop at the next `##`.
 *
 * `content` may open with the section's own heading, and usually does — a model sends a section
 * whole. That heading replaces the old one (a rename, when its text differs) rather than landing
 * under it. It used to land under it: `## Hardware` sent with its heading read back as two, the next
 * replace rewrote only the first and empty one, and every older version stayed in the file below
 * its own copy of the heading. On a live agent that was one checkpoint four times and three
 * different answers to one question, all of it in every prompt.
 */
export function replaceSection(source: string, section: string, content: string): string | null {
  const lines = source.split("\n");
  const wanted = wantedOf(section);

  let startIndex = -1;
  let depth = 0;

  for (const [index, line] of lines.entries()) {
    const heading = headingOf(line);
    if (heading?.text.toLowerCase() === wanted) {
      startIndex = index;
      depth = heading.depth;
      break;
    }
  }

  if (startIndex === -1) return null;

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index++) {
    const heading = headingOf(lines[index] ?? "");
    if (heading && heading.depth <= depth) {
      endIndex = index;
      break;
    }
  }

  // A deeper heading first is a subsection of this one, and stays content.
  const [first = "", ...rest] = content.trim().split("\n");
  const lead = headingOf(first);
  const own = lead !== null && lead.depth <= depth;
  const heading = own ? `${"#".repeat(depth)} ${lead.text}` : (lines[startIndex] ?? `${"#".repeat(depth)} ${section}`);
  const body = own ? rest.join("\n").trim() : content.trim();
  const before = lines.slice(0, startIndex);
  const after = lines.slice(endIndex);

  return [...before, heading, "", body, "", ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}
