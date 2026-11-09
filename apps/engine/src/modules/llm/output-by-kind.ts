/**
 * A tool result made smaller by what its text is, before it enters the context (0.8.17).
 *
 * What a command prints carries bytes no model reads: a terminal's colour codes, a progress bar redrawn a hundred
 * times on one line, the same warning printed sixty times, JSON indented for a person. Each is paid for on the request
 * that carries it and on every request after while the result stays in the history. So, by kind:
 *
 * - colour and cursor codes are taken out;
 * - a line redrawn with carriage returns is kept at its last state (a line that ends `\r\n` is a line, not a redraw);
 * - a run of three or more identical lines that are not blank becomes one, marked `[× N]`;
 * - text that is JSON as a whole loses the spaces between its tokens, never inside a string, and its numbers are kept
 *   as written (parsed and printed again, an id past 2^53 would change).
 *
 * Diffs keep their lines: a run of identical lines is content there. The output of a tool that returns content to be
 * kept exactly (`Tool.verbatim`: a file's lines) is never touched. When a result is made smaller, its whole text is
 * written to the conversation's spill folder first and the result ends with one line naming it; without that file
 * nothing is taken out.
 */

import type { Tool, ToolResult } from "@nouride/shared";
import type { KeptToolOutput } from "./context.ts";

/**
 * Less saved than this and the result stays as it is: the line that says so and the file it names cost about what
 * they would save, and the colour codes of a short output are not worth a file.
 */
const MIN_SAVED_CHARS = 256;

/** The fewest identical lines in a row that become one. Two in a row is too common in code and lists to mean noise. */
const MIN_RUN = 3;

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC \`), and the two-character escapes. Built from code points, so
// no control character sits in this source.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`, "g");

/** The text made smaller, and the kinds that did it, in the words the result's last line uses. */
export function compactByKind(text: string): { text: string; kinds: string[] } {
  const kinds: string[] = [];
  let out = text.replace(ANSI, "");
  if (out !== text) kinds.push("colour codes taken out");

  const lines = out.split("\n");
  const redrawn = lines.map(lastState);
  if (redrawn.some((line, i) => line !== lines[i])) {
    out = redrawn.join("\n");
    kinds.push("redrawn lines kept at their last state");
  }

  const json = jsonWithoutSpaces(out);
  if (json !== null && json !== out) {
    out = json;
    kinds.push("JSON without its spaces");
  } else if (json === null && !looksLikeDiff(out)) {
    const collapsed = collapseRuns(out);
    if (collapsed !== out) {
      out = collapsed;
      kinds.push("repeated lines counted");
    }
  }
  return { text: out, kinds };
}

/**
 * A tool's result after `compactByKind`, with its whole text kept by `keep` and named on its last line; the result as
 * it was when the tool keeps its output exact, when the output is already on disk, or when too little is saved.
 */
export function compactResult(result: ToolResult, tool: Pick<Tool, "verbatim">, keep: (content: string) => KeptToolOutput | null): ToolResult {
  if (tool.verbatim || result.spooled) return result;
  const { text, kinds } = compactByKind(result.content);
  const saved = result.content.length - text.length;
  if (kinds.length === 0 || saved < MIN_SAVED_CHARS) return result;
  const kept = keep(result.content);
  if (!kept) return result;
  const line = `[made smaller for the context (${kinds.join("; ")}): ${saved} characters fewer. The whole output: ${kept.path}]`;
  return { ...result, content: `${text}\n${line}`, metadata: { ...result.metadata, compactedFrom: kept.path } };
}

/** A line's last drawn state: what follows its last carriage return, its own `\r\n` ending left alone. */
function lastState(line: string): string {
  const ending = line.endsWith("\r") ? "\r" : "";
  const body = ending ? line.slice(0, -1) : line;
  if (!body.includes("\r")) return line;
  const drawn = body.split("\r").filter((part) => part.length > 0);
  return (drawn[drawn.length - 1] ?? "") + ending;
}

/** Runs of `MIN_RUN` or more identical lines that are not blank, as one line and how many there were. */
function collapseRuns(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j += 1;
    const run = j - i;
    out.push(run >= MIN_RUN && lines[i]!.trim() !== "" ? `${lines[i]} [× ${run}]` : lines.slice(i, j).join("\n"));
    i = j;
  }
  return out.join("\n");
}

/** A unified diff: its hunks are content, a repeated line there is a line of the file. */
function looksLikeDiff(text: string): boolean {
  return /^(diff --git |@@ -\d+(,\d+)? \+\d+(,\d+)? @@)/m.test(text) || (/^--- \S/m.test(text) && /^\+\+\+ \S/m.test(text));
}

/**
 * Text that is JSON as a whole, without the spaces between its tokens; null when it is not JSON. Done by walking the
 * characters, not by parsing and printing: that would rewrite numbers (`1.50` as `1.5`, an id past 2^53 to another).
 */
function jsonWithoutSpaces(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    JSON.parse(trimmed);
  } catch {
    return null;
  }
  let out = "";
  let inString = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += trimmed[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") {
      out += c;
    }
  }
  return out;
}
