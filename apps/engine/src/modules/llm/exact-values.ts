/**
 * The values a summary must not smooth away.
 *
 * A summarizer asked to be brief turns "moved staging Postgres to 192.168.0.11:5433" into "fixed the
 * staging database", and ten turns later the agent is asked for the port and has nothing to give but a
 * guess. The prompt asks for exact values; this is what holds when the model does not listen: every
 * host, address, URL, path, hash, id and numeric setting the people in the conversation said is found
 * by pattern, and whichever the summary left out is appended verbatim.
 *
 * Only what the people and the agent *said* — not tool output, which is full of paths nobody cares
 * about, and previous summaries, so a value survives every later compaction as well as the first.
 * Values set as `key=<text>` are left out: that shape is how a token or password gets pasted, and a
 * summary is kept for the rest of the session.
 */

/** Absolute, home- or dot-relative, or relative with a file extension — "and/or" is not a path. */
const PATH = /(?<![\w/])(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+/g;
const isPath = (value: string) => /^[/~.]/.test(value) || /\.[a-z]\w*$/i.test(value);

const PATTERNS: RegExp[] = [
  /\bhttps?:\/\/[^\s)>\]"'`]+/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g,
  /\b[a-z][\w-]*(?:\.[\w-]+)*:\d{2,5}\b/gi,
  PATH,
  /\b[a-z_][\w.]*=(?:\d+(?:\.\d+)?|true|false)\b/gi,
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)(?:[0-9a-f]{7,12}|[0-9a-f]{40})\b/g,
];

/** Enough for a working session's handful of hosts and files; past it the list is noise. */
const MAX_VALUES = 24;

/** The heading appended values sit under, so a later compaction reads them as what they are. */
const HEADING = "Exact values (kept verbatim by the daemon):";

/** Exact values in `text`, most recent last, each once. */
function exactValues(text: string): string[] {
  const found: { value: string; at: number }[] = [];
  let rest = text;
  for (const pattern of PATTERNS) {
    for (const match of rest.matchAll(pattern)) {
      const value = match[0].replace(/[.,:;]+$/, "");
      if (value.length < 4 || (pattern === PATH && !isPath(value))) continue;
      found.push({ value, at: match.index ?? 0 });
    }
    // A URL's host and path are not found again as values of their own.
    rest = rest.replace(pattern, (m) => " ".repeat(m.length));
  }
  const seen = new Set<string>();
  const ordered = found.sort((a, b) => a.at - b.at).map((f) => f.value);
  const unique: string[] = [];
  for (let i = ordered.length - 1; i >= 0; i--) {
    const value = ordered[i]!;
    if (seen.has(value)) continue;
    seen.add(value);
    unique.unshift(value);
  }
  return unique.slice(-MAX_VALUES);
}

/** `summary`, with whatever exact value of `source` it dropped appended under one heading. */
export function keepExactValues(summary: string, source: string): string {
  const missing = exactValues(source).filter((value) => !summary.includes(value));
  if (missing.length === 0) return summary;
  return `${summary}\n\n${HEADING}\n${missing.map((value) => `- ${value}`).join("\n")}`;
}
