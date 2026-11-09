/**
 * An agent's headline: one line in its IDENTITY.md, `- **Headline:** …`, saying what it is for — what its peers read to
 * choose whom to ask (OTHER AGENTS, `ask_agent`) and what the Agents pages show (0.7.18). Not its system prompt or
 * SOUL.md: those say how it works, this says what to bring it.
 *
 * Kept in IDENTITY.md rather than in config: it is the file every pack has, and one place means the dashboard and the
 * peers can never disagree. A `Role:` line (packs before 0.7.18) is not the headline since 0.8.0 — 0.7.x rewrote it —
 * and is left as written when one is set.
 */

import { oneLine } from "@nouride/shared";

/** Longest a headline may be: a sentence, not a description — the owner's number (0.7.18). A peer's line fits it whole. */
export const HEADLINE_MAX = 150;

/** A headline as typed, made one line: whitespace runs to a space, trimmed; null when nothing is left or it is too long. */
export function cleanHeadline(headline: string): string | null {
  const line = oneLine(headline);
  return line && line.length <= HEADLINE_MAX ? line : null;
}

/** The `Headline:` line. */
const HEADLINE_LINE = /^\s*[-*+]?\s*(?:\*\*|__)?headline(?:\*\*|__)?\s*:(?:\*\*|__)?\s*.*$/im;

/**
 * IDENTITY.md with its headline set: the `Headline:` line replaced where there is one, or added after the `Name:` line,
 * or after the heading, or at the top. Nothing else in the file moves.
 */
export function withHeadline(identity: string, headline: string): string {
  const line = `- **Headline:** ${headline}`;
  if (HEADLINE_LINE.test(identity)) return identity.replace(HEADLINE_LINE, line);
  const lines = identity.split("\n");
  const name = lines.findIndex((l) => /^\s*[-*+]?\s*(?:\*\*|__)?name(?:\*\*|__)?\s*:/i.test(l));
  const heading = lines.findIndex((l) => /^#/.test(l));
  const at = name >= 0 ? name + 1 : heading >= 0 ? heading + 1 : 0;
  // After a heading, keep the blank line a heading is followed by.
  const blank = name < 0 && heading >= 0 && lines[at] === "" ? 1 : 0;
  lines.splice(at + blank, 0, line);
  return lines.join("\n");
}
