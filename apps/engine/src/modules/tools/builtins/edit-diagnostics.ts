/**
 * Why an exact-string edit missed, said precisely enough to fix in one retry.
 *
 * `edit` and `multi_edit` match `old_string` byte for byte and refuse anything ambiguous. That is the
 * right matcher and it is not what this file changes — a fuzzy apply is the failure class this whole
 * design exists to avoid, and a line-range replace is worse still, because line numbers go stale
 * between the read and the write with nothing anchoring them.
 *
 * What was wrong is the **failure**. "`old_string` was not found in the file." carries no information
 * at all, so a model that is one space of indentation out has nothing to work from and retries blind
 * — which is where the wasted turns actually go. The fix is diagnosis, not tolerance: find where the
 * text nearly matched, say exactly what differs, and let the model send a correct `old_string`.
 *
 * Everything here is read-only and pure. It never selects a replacement site — the caller has already
 * decided nothing will be written.
 */

import { plural } from "@nouride/shared";

/**
 * A file this size is a generated bundle, not something an agent is hand-editing.
 *
 * Diagnosis walks the file line by line, and doing that on a 40MB artefact to explain a failed edit
 * spends more than the edit was worth. Above the cap the caller gets the bare refusal, which is what
 * it had before this file existed.
 */
const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;

/** Line numbers reported for an anchor match, before it stops being a hint and starts being a list. */
const MAX_ANCHOR_HITS = 3;

/**
 * One sentence to append to a "not found" refusal, or "" when there is nothing useful to say.
 *
 * Returns a *suffix* rather than the whole message so the two callers keep their own framing —
 * `multi_edit` numbers its failures ("Edit 3 of 6") and `edit` does not.
 */
export function diagnoseEditMiss(original: string, needle: string): string {
  if (original.length > MAX_DIAGNOSTIC_BYTES || needle === "") return "";

  /**
   * CRLF first, because it explains a miss that is invisible in every other report.
   *
   * A file with Windows line endings against an `old_string` the model composed with `\n` differs at
   * the end of every single line. Reported as an indentation or whitespace difference that would be
   * true and useless — the model would "fix" the indentation and miss again. It is also the one cause
   * a person cannot see by reading the tool result, so it goes first and returns immediately.
   */
  if (needle.includes("\n") && original.includes("\r\n") && !needle.includes("\r\n")) {
    return (
      " The file uses CRLF line endings and `old_string` uses LF, so every line break differs. " +
      "Read the file again and copy the text exactly, or replace a single line that has no break in it."
    );
  }

  const sourceLines = original.split("\n");
  const needleLines = needle.split("\n");

  const window = findTrimmedWindow(sourceLines, needleLines);
  if (window !== null) {
    return describeWindow(sourceLines, needleLines, window);
  }

  return describeAnchor(sourceLines, needleLines);
}

/**
 * The first place every line matches once leading and trailing whitespace is discarded.
 *
 * Candidate starts come from an index of the first needle line rather than from sliding over the
 * whole file, so a 50-line `old_string` against a 20,000-line file is a handful of comparisons and
 * not a million. The saving matters because this runs on a failure path inside a file lock.
 */
function findTrimmedWindow(sourceLines: string[], needleLines: string[]): number | null {
  const first = needleLines[0]?.trim() ?? "";
  // A blank first line indexes nothing useful — it would match every empty line in the file — so the
  // anchor path handles that case instead.
  if (first === "") return null;

  for (let start = 0; start + needleLines.length <= sourceLines.length; start += 1) {
    if ((sourceLines[start] ?? "").trim() !== first) continue;

    let matched = true;
    for (let offset = 1; offset < needleLines.length; offset += 1) {
      if ((sourceLines[start + offset] ?? "").trim() !== (needleLines[offset] ?? "").trim()) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return null;
}

/**
 * The text is there — say which of the three whitespace differences it is.
 *
 * Named specifically rather than reported as "differs in whitespace", because the three have
 * different fixes and only one of them is guessable. Trailing whitespace is invisible in every
 * rendering of the file the model has seen; a tab-versus-spaces file cannot be fixed by counting;
 * and an indentation depth can be, once someone says what the depth is.
 */
function describeWindow(sourceLines: string[], needleLines: string[], start: number): string {
  const line = start + 1;
  const actual = sourceLines.slice(start, start + needleLines.length);

  const trailingOnly =
    actual.map(trimEnd).join("\n") === needleLines.map(trimEnd).join("\n");
  if (trailingOnly) {
    return (
      ` The same text is at line ${line}, differing only in trailing whitespace: one or more lines ` +
      `end in spaces or tabs that \`old_string\` does not have. Read that range and copy it verbatim.`
    );
  }

  const actualIndent = indentOf(actual);
  const needleIndent = indentOf(needleLines);
  if (actualIndent.kind !== needleIndent.kind) {
    return (
      ` The same text is at line ${line}, indented with ${actualIndent.kind} while \`old_string\` uses ` +
      `${needleIndent.kind}. Read that range and copy it verbatim rather than retyping it.`
    );
  }
  if (actualIndent.width !== needleIndent.width) {
    return (
      ` The same text is at line ${line}, indented ${actualIndent.width} ${actualIndent.kind} deep ` +
      `while \`old_string\` is indented ${needleIndent.width}. Re-send it at the file's depth.`
    );
  }

  return (
    ` The same text is at line ${line} but the whitespace inside the lines differs: a run of spaces ` +
    `where \`old_string\` has one, or a tab mid-line. Read that range and copy it verbatim.`
  );
}

/**
 * No window matched — report where the *first line* of `old_string` lives, if anywhere.
 *
 * This is the "you are editing the wrong region, or the file moved on" case, and a line number is
 * still the most useful thing to hand back: the model can read there and see what the text actually
 * says now. Reported as a location to look at, never as a site to edit.
 */
function describeAnchor(sourceLines: string[], needleLines: string[]): string {
  const anchor = needleLines.find((line) => line.trim() !== "")?.trim();
  if (anchor === undefined || anchor.length < 4) return "";

  const hits: number[] = [];
  for (const [index, line] of sourceLines.entries()) {
    if (line.trim() === anchor) {
      hits.push(index + 1);
      if (hits.length > MAX_ANCHOR_HITS) break;
    }
  }

  if (hits.length === 0) {
    return " No line in the file matches the first line of `old_string` either, even ignoring whitespace. Read the file again: it may not say what you think it says.";
  }
  if (hits.length > MAX_ANCHOR_HITS) {
    return ` Its first line appears at more than ${MAX_ANCHOR_HITS} places in the file, but the block as a whole matches none of them. Read one of them to see what follows it now.`;
  }
  return ` Its first line is at ${plural(hits.length, "line")} ${hits.join(", ")}, but the lines after it differ. Read there and copy the current text.`;
}

function trimEnd(line: string): string {
  return line.replace(/[ \t]+$/, "");
}

/**
 * The indentation of the first line that has any, described as a kind and a width.
 *
 * The first *indented* line rather than the first line, because an `old_string` copied out of a file
 * routinely starts at column zero while the block under it is nested — measuring line one would
 * report "0 spaces" for both sides and find no difference where there is an obvious one.
 */
function indentOf(lines: string[]): { kind: "spaces" | "tabs"; width: number } {
  for (const line of lines) {
    const match = /^[ \t]+/.exec(line);
    if (!match || line.trim() === "") continue;
    const lead = match[0];
    return lead.includes("\t")
      ? { kind: "tabs", width: lead.length }
      : { kind: "spaces", width: lead.length };
  }
  return { kind: "spaces", width: 0 };
}
