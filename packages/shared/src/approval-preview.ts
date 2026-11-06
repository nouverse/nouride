/**
 * What a human is actually being asked to approve.
 *
 * The prompt used to print the tool's arguments as formatted JSON, which for a `write` meant the entire
 * file — a 3KB landing page scrolled past, three times in one turn, and the operator answered `y` without
 * reading any of it. That is the failure mode a gate has to avoid: an approval nobody can read is an
 * approval nobody is making.
 *
 * Structured rather than pre-rendered text, because the two consumers want different things. A terminal
 * has width and colour and can show a diff; a Telegram bubble read on a phone wants three lines. One
 * decision about *what matters*, two decisions about how to draw it.
 *
 * Deliberately not the whole content. The full arguments are in the audit log and `nouride approvals`
 * shows them in full — this is the summary you decide from, and it says so when it has left something out.
 */

import { formatBytes } from "./bytes.ts";

export type ApprovalPreview =
  /** A file that does not exist yet. Nothing is at risk but disk space, so stats are enough. */
  | { kind: "new_file"; path: string; lines: number; bytes: number }
  /**
   * A file that does exist. The number that matters is what is being *lost*, so the old size leads —
   * "replaces 400 lines with 12" is a different decision from "creates 12 lines".
   */
  | { kind: "overwrite"; path: string; lines: number; bytes: number; wasLines: number; wasBytes: number }
  /** A targeted replacement, where the change itself is small enough to show. */
  | {
      kind: "edit";
      path: string;
      added: number;
      removed: number;
      hunk: DiffLine[];
      clipped: boolean;
      /**
       * The file the diff was made against, as its sha256 — a persona change's (0.8.13): stored with the request, so the
       * write the answer allows checks the file is still that one, after a restart too. Absent from a generic edit's.
       */
      against?: string;
    }
  /**
   * A command, in the form an operator recognises from a shell.
   *
   * `shell` marks the case where the command *is* a shell: `sh -c "…"`. Worth its own flag because
   * the two read identically in a prompt and are not the same decision — approving `ls -la` is
   * approving one program, and approving `sh -c` is approving whatever that line turns out to mean,
   * including the parts a glance skips past.
   */
  | { kind: "command"; command: string; cwd?: string; clipped: boolean; shell?: boolean }
  /** Anything else: compact JSON, clipped if long. */
  | { kind: "params"; json: string; clipped: boolean };

/**
 * Interpreters whose whole purpose is to run a string as a program.
 *
 * `exec` refuses shell *syntax* in the string form of `command`, but an argv array is passed through
 * unchecked — `["sh", "-c", "a && b | c"]` reaches a real shell. That is not a hole in the approval
 * gate, which still asks; it is a hole in what the prompt *tells* the human, and this closes that.
 */
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);

export function isShellInvocation(command: unknown): boolean {
  const argv = Array.isArray(command) ? command.map(String) : undefined;
  if (!argv || argv.length < 2) return false;
  const program = (argv[0] ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  // `-c` is the flag that turns an interpreter into "run this string". `sh script.sh` is an ordinary
  // program running an ordinary file, and the grant machinery already hashes that file.
  return SHELL_PROGRAMS.has(program) && argv.slice(1).includes("-c");
}

/**
 * One line of an edit's hunk: taken out, put in, or — in a persona change — kept and shown because what it means moved
 * with a line above it that was reworded (` `).
 */
export interface DiffLine {
  sign: "-" | "+" | " ";
  text: string;
}

/** Beyond this a hunk stops being glanceable and becomes the dump this exists to replace. */
const MAX_HUNK_LINES = 14;
/** A command longer than this cannot meaningfully be approved from a chat bubble. */
const MAX_COMMAND_CHARS = 300;
const MAX_JSON_CHARS = 300;

function countLines(text: string): number {
  if (text === "") return 0;
  // A trailing newline terminates the last line rather than starting an empty one, which is why `wc -l`
  // and a naive split disagree. Matching `wc -l` keeps the number the operator can verify.
  const bare = text.endsWith("\n") ? text.slice(0, -1) : text;
  return bare.split("\n").length;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Split a hunk fairly between what is going and what is arriving.
 *
 * Showing the first N lines of a 200-line removal and none of the addition tells the operator what they
 * are losing and nothing about what they are getting. Half each, removals first.
 */
function buildHunk(oldText: string, newText: string): { hunk: DiffLine[]; clipped: boolean } {
  const removed = oldText === "" ? [] : oldText.split("\n");
  const added = newText === "" ? [] : newText.split("\n");

  const half = Math.floor(MAX_HUNK_LINES / 2);
  const removedShown = removed.length > half ? removed.slice(0, half) : removed;
  const addedShown = added.length > half ? added.slice(0, half) : added;

  const hunk: DiffLine[] = [
    ...removedShown.map((text): DiffLine => ({ sign: "-", text })),
    ...addedShown.map((text): DiffLine => ({ sign: "+", text })),
  ];

  return {
    hunk,
    clipped: removedShown.length < removed.length || addedShown.length < added.length,
  };
}

export interface PreviewContext {
  /**
   * Size of the file a path refers to, or null when it does not exist.
   *
   * Injected because whether a `write` creates or destroys is the single most important fact in the
   * prompt, and it is only knowable by looking. Returning null for "cannot tell" is deliberate: the
   * preview then describes a new file, which is the *less* alarming reading, so a stat that fails must
   * never be the reason an overwrite looks harmless — callers pass a resolver that only fails when the
   * file genuinely is not there.
   */
  statFile(path: string): { lines: number; bytes: number } | null;
}

/**
 * The one fact about a tool call worth putting in front of a human.
 *
 * Keyed on the tool's own parameter shape rather than a list of tool names: `path` + `content` is a whole
 * file, `old_string` + `new_string` is a replacement, `command` is a command. A new tool that borrows one
 * of those shapes gets a readable prompt without being added here.
 */
export function buildApprovalPreview(
  _tool: string,
  params: Record<string, unknown>,
  ctx: PreviewContext,
): ApprovalPreview {
  const path = typeof params.path === "string" ? params.path : undefined;

  if (path !== undefined && typeof params.old_string === "string" && typeof params.new_string === "string") {
    const { hunk, clipped } = buildHunk(params.old_string, params.new_string);
    return {
      kind: "edit",
      path,
      removed: countLines(params.old_string),
      added: countLines(params.new_string),
      hunk,
      clipped,
    };
  }

  if (path !== undefined && typeof params.content === "string") {
    const content = params.content;
    const existing = ctx.statFile(path);
    // `write` with `append` (0.7.25): lines added to the end and none taken away — an edit, said as one. Read as a
    // whole file it said "replaces 400 lines with 12", the most alarming reading of the least destructive call.
    if (existing && params.append === true) {
      const { hunk, clipped } = buildHunk("", content);
      return { kind: "edit", path, added: countLines(content), removed: 0, hunk, clipped };
    }
    if (existing) {
      return {
        kind: "overwrite",
        path,
        lines: countLines(content),
        bytes: byteLength(content),
        wasLines: existing.lines,
        wasBytes: existing.bytes,
      };
    }
    return { kind: "new_file", path, lines: countLines(content), bytes: byteLength(content) };
  }

  const command = Array.isArray(params.command)
    ? params.command.map(String).join(" ")
    : typeof params.command === "string"
      ? params.command
      : undefined;
  if (command !== undefined) {
    return {
      kind: "command",
      command: command.slice(0, MAX_COMMAND_CHARS),
      ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
      clipped: command.length > MAX_COMMAND_CHARS,
      ...(isShellInvocation(params.command) ? { shell: true } : {}),
    };
  }

  const json = JSON.stringify(params) ?? "{}";
  return { kind: "params", json: json.slice(0, MAX_JSON_CHARS), clipped: json.length > MAX_JSON_CHARS };
}

/**
 * One line naming the change, shared by every renderer.
 *
 * The renderers differ in what they add around it — a terminal follows with a coloured hunk, a chat
 * message with the id and the commands to answer — but they must not differ in what the change *is*.
 */
export function previewHeadline(preview: ApprovalPreview): string {
  switch (preview.kind) {
    case "new_file":
      return `${preview.path} · new file · ${preview.lines} lines, ${formatBytes(preview.bytes)}`;
    case "overwrite": {
      // A negative old line count means it was not counted — a file too large to read just to produce a
      // cosmetic number. Bytes alone then, rather than a plausible-looking line count nobody measured.
      const was =
        preview.wasLines < 0
          ? formatBytes(preview.wasBytes)
          : `${preview.wasLines} lines (${formatBytes(preview.wasBytes)})`;
      return `${preview.path} · replaces ${was} with ${preview.lines} lines (${formatBytes(preview.bytes)})`;
    }
    case "edit":
      return `${preview.path} · +${preview.added} −${preview.removed}`;
    case "command":
      return preview.clipped ? `${preview.command}… (clipped)` : preview.command;
    case "params":
      return preview.clipped ? `${preview.json}… (clipped)` : preview.json;
  }
}
