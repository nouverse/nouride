/**
 * A tool result too big for the context goes to disk, and the model gets a pointer.
 *
 * The gap this closes: `security.tool_max_output_bytes` is 10MB, which is roughly two and a half
 * million tokens — a memory-safety cap wearing the clothes of a context cap. A single `exec` that
 * printed a 6.6MB log went into the working set whole, and the only thing standing between that and a
 * dead turn was `trimToolResults`, which cannot touch the newest few results and therefore cannot
 * touch the one that just arrived. It became a marker three tool calls later, having been paid for on
 * every request in between.
 *
 * The prompt already *asks* the model to do this ("write it to a file and carry the path"). That is
 * advice, and advice is not a guarantee: the model has to remember, before it has seen how big the
 * output is, on the one call where getting it wrong is expensive. **So the harness does it instead**,
 * deterministically, on the way back from every tool.
 *
 * ## What the model gets
 *
 * Head and tail, never the middle. A long log carries its signal at the two ends — what it set out to
 * do, and whether it worked — and the middle is the part a person scrolls past. Cutting there is the
 * one cut that keeps a truncated log readable.
 *
 * Plus the path, plus how to read more. The path is real and openable: the spill directory is a
 * read-only root for `read`, `grep` and `glob`, so "narrow it with grep" is an instruction the agent
 * can actually follow rather than a suggestion it cannot act on.
 *
 * ## Why files and not another marker
 *
 * `trimToolResults` shrinks what is still there later, and since 0.7.25 it keeps what it clears here too
 * (`keepCleared`) — re-running a ninety-second command to see line 40,000 is worse than opening a file,
 * and re-running one that changed something is no way back at all. The two mechanisms are ordered —
 * this one caps what enters, that one moves out what is still there later.
 */

import { agentReadableMode, ensureDir, fileExistsSync, join, listDir, removePath, setFileMode, sha256Text, statFile, writeBytesSync, writeTextFileAtomic } from "@nouride/runtime";
import { createLogger, rootSessionOf, type ChatMessage, type SpooledOutput } from "@nouride/shared";
import type { KeepCleared, KeptToolOutput } from "./context.ts";

const log = createLogger("llm.spill");

/**
 * Share of the spilled excerpt given to the head, the rest to the tail.
 *
 * Weighted forward because the start of a command's output is what identifies it — the invocation, the
 * plan, the first error. The tail answers "did it finish", which needs fewer lines to say.
 */
const HEAD_SHARE = 0.65;

/** Characters per token, matching `estimateTokens` closely enough to size an excerpt by. */
const CHARS_PER_TOKEN = 4;

/** The characters a result may carry before it is spilled — what `ToolContext.resultChars` tells a tool. */
export function resultCharsFor(maxTokens: number): number {
  return Math.max(0, maxTokens) * CHARS_PER_TOKEN;
}

export interface SpillRequest {
  /** Whose output it is. The directory is per agent, and so is the sandbox root that opens it. */
  agentId: string;
  /** Scopes the file, so a `/new` or a retention sweep can reason about one conversation. */
  sessionId: string;
  /** The provider's tool-call id — unique within a turn, so two big results never collide. */
  callId: string;
  toolName: string;
  content: string;
  /** Tokens the excerpt may occupy. Everything past it lives only in the file. */
  maxTokens: number;
  /**
   * The tool already wrote the whole output to disk as it streamed, and `content` is only its ends.
   *
   * Then nothing is written here — the file exists — and the result is always an excerpt, even when
   * `content` would fit: it is not the output, and handing it back as though it were would be the
   * silent substitution the header exists to prevent.
   */
  spooled?: SpooledOutput;
}

export interface SpillOutcome {
  /** What to hand the model in place of the full content. */
  content: string;
  /** Absolute path written, or null when the content fit and nothing was written. */
  path: string | null;
}

/** Who a spill directory belongs to. */
export interface SpillScope {
  agentId: string;
  sessionId: string;
}

export class ToolOutputSpill {
  /**
   * The directory exists from boot, not from the first spill.
   *
   * Same as `JobsPort`: a directory handed to the sandbox should exist before anything asks about it.
   */
  constructor(private readonly dir: string) {
    ensureDir(dir);
  }

  /**
   * The one directory a turn may open: its own agent's, for its own conversation.
   *
   * This used to be the whole spill directory, handed to every agent — so one agent could read what
   * another's commands printed, in any conversation, for as long as retention kept it. A tool result
   * holds whatever the command read: a config file, a dump, a customer's message. The directory is
   * therefore cut the same way the private workspace is, by agent, and then by conversation.
   *
   * By the *root* conversation (`rootSessionOf`), not the session id the turn carries: a `delegate`
   * helper runs under a child id, and the lead it reports to has to be able to open the file the
   * helper names. A peer answering `ask_agent` is a different agent, so its files stay its own — it
   * reports what it found, not where.
   *
   * Created here, because the sandbox is given this path as a root before any tool has written to it.
   */
  rootFor(scope: SpillScope): string {
    const dir = join(this.dir, safeSegment(scope.agentId), safeSegment(rootSessionOf(scope.sessionId)));
    ensureDir(dir);
    return dir;
  }

  /** Where one call's full output goes. Only a path; nothing is created until someone writes it. */
  pathFor(scope: SpillScope & { callId: string }): string {
    return join(this.rootFor(scope), `${safeSegment(scope.callId)}.txt`);
  }

  /**
   * Cap one tool result, writing the full text to disk when it does not fit.
   *
   * Returns the content unchanged when it fits — the common case, and it must cost nothing. A failed
   * write is *not* a failed tool call: the excerpt is still the most useful thing available, so the
   * error is logged and the model is told the file is missing rather than the turn being aborted.
   */
  async keep(request: SpillRequest): Promise<SpillOutcome> {
    const budgetChars = resultCharsFor(request.maxTokens);
    if (request.spooled) {
      return {
        content: render(request, budgetChars, request.spooled.path, request.spooled),
        path: request.spooled.path,
      };
    }
    if (request.content.length <= budgetChars) {
      return { content: request.content, path: null };
    }

    let path: string | null = null;
    try {
      path = this.pathFor(request);
      await writeTextFileAtomic(path, request.content);
      // A tool result can hold anything the agent read — a credential file, a database dump. Same
      // mode the job logs use: the daemon's, and its agent's where that agent is its own user.
      setFileMode(path, agentReadableMode());
    } catch (error) {
      path = null;
      log.error("could not spill a large tool result, so handing back the excerpt only", {
        tool: request.toolName,
        session_id: request.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    log.info("spilled a large tool result", {
      tool: request.toolName,
      session_id: request.sessionId,
      bytes: request.content.length,
      kept_tokens: request.maxTokens,
      written: path !== null,
    });

    return { content: render(request, budgetChars, path), path };
  }

  /**
   * Keep a tool result the context is about to clear, and say where (0.7.25).
   *
   * The marker that replaces it names the file, so the agent opens it with `read` instead of running the command again
   * — which for a command that changed something is not a way back at all. One file per cleared result, in the same
   * directory and under the same retention as a spilled one, named by its call id (`cleared-<call>-<hash>.txt`: a call
   * id is unique within a turn only, so the content's hash keeps two turns' `call_0` apart, and clearing the same
   * result twice writes it once).
   *
   * A result that was spilled already is an excerpt of a file that exists: the marker points at that file, and nothing
   * is written. Synchronous, because the trim it serves is: a few files in a turn that is clearing tens of kilobytes.
   * Never throws — a write that fails is a warning, and the caller keeps the old marker rather than losing the turn.
   */
  keepCleared(scope: SpillScope & { callId: string }, content: string): KeptToolOutput | null {
    const spilled = this.spilledIn(content);
    if (spilled) return spilled;
    const lines = content.split("\n").length;
    const kb = Math.max(1, Math.round(content.length / 1024));
    try {
      const path = join(this.rootFor(scope), `cleared-${safeSegment(scope.callId)}-${sha256Text(content).slice(0, 12)}.txt`);
      // Same mode as a spilled result: it holds whatever the tool read.
      if (!fileExistsSync(path)) writeBytesSync(path, new TextEncoder().encode(content), agentReadableMode());
      return { path, lines, kb };
    } catch (error) {
      log.warn("could not keep a cleared tool result, so it is dropped from the context with nothing kept", {
        session_id: scope.sessionId,
        call_id: scope.callId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** `keepCleared` for one conversation's results, as the trim and the prune take it. */
  keeperFor(scope: SpillScope): KeepCleared {
    return (message: ChatMessage, text: string) => this.keepCleared({ ...scope, callId: message.toolCallId ?? "result" }, text);
  }

  /**
   * The file a spilled excerpt points at, with the whole output's size from its header — when it is one of ours and
   * still there. Inside this store only: a tool result is text anything can print, and one that merely looks like an
   * excerpt must not have the marker point somewhere else.
   */
  private spilledIn(content: string): KeptToolOutput | null {
    const header = /^\[output too large for the context(?::| —) (\d+) lines, ~(\d+)KB\./.exec(content); // em-dash-ok: 0.8.15 and older wrote " — ", kept in stored conversations
    const path = /^Full output: (.+)$/m.exec(content)?.[1]?.trim();
    if (!header || !path || !path.startsWith(`${this.dir}/`) || path.includes("/../") || !fileExistsSync(path)) return null;
    return { path, lines: Number(header[1]), kb: Number(header[2]) };
  }

  /**
   * Drop one conversation's files, for `/new`, `/reset` and a rollover.
   *
   * The conversation that pointed at them is gone, and the session id is derived from the chat, so
   * the next conversation in it would otherwise inherit a directory of output it never produced.
   * Never throws: a reset must not fail over a file that could not be removed — the sweep gets it.
   */
  forget(scope: SpillScope): void {
    const dir = join(this.dir, safeSegment(scope.agentId), safeSegment(rootSessionOf(scope.sessionId)));
    try {
      removePath(dir);
    } catch (error) {
      log.warn("could not drop a conversation's spilled output, so the retention sweep will", {
        session_id: scope.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Delete spilled output older than `days`. `0` disables the sweep rather than deleting everything —
   * the same off position `[attachments] retention_days` uses, and for the same reason: a knob whose
   * zero wipes a directory eventually wipes one.
   *
   * Swept by **directory mtime**, so a conversation still producing output keeps its whole spill set
   * and a finished one goes as a unit. Per-file would strand a session whose first call is old and
   * whose last is minutes ago, which is exactly the session still being read from.
   */
  sweep(days: number, now: number = Date.now()): number {
    if (days <= 0) return 0;
    const cutoff = now - days * 24 * 60 * 60_000;
    let removed = 0;

    const sweepDir = (path: string): boolean => {
      const stat = statFile(path);
      if (!stat || stat.mtimeMs >= cutoff) return false;
      removePath(path);
      return true;
    };

    for (const entry of listDir(this.dir)) {
      if (!entry.isDirectory) continue;
      const path = join(this.dir, entry.name);
      const children = listDir(path);
      /**
       * Two layouts, because a daemon upgraded mid-conversation has both on disk.
       *
       * An agent directory holds conversation directories. A directory holding only files is a
       * conversation from before the split, and goes by its own mtime as it always did. Telling them
       * apart by the agent's name would not work: an agent directory's mtime changes only when a
       * conversation is added, so sweeping it as a unit would delete a conversation still in use.
       */
      if (children.length > 0 && children.every((child) => !child.isDirectory)) {
        if (sweepDir(path)) removed += 1;
        continue;
      }
      for (const child of children) {
        if (child.isDirectory && sweepDir(join(path, child.name))) removed += 1;
      }
      if (listDir(path).length === 0) removePath(path);
    }

    return removed;
  }
}

/**
 * The replacement content.
 *
 * Every number in it is measured, not estimated: the model is entitled to know exactly what it is not
 * seeing, because the alternative is a truncated log it reads as the whole log. That has a name here —
 * silently substituting a short result invites the model to conclude the command printed nothing and
 * report success.
 */
function render(
  request: SpillRequest,
  budgetChars: number,
  path: string | null,
  whole?: SpooledOutput,
): string {
  const lines = request.content.split("\n");
  // Same rule as the streamed count in `exec-output.ts`: a trailing newline ends a line, it does not
  // start one, so the header never claims a line the output does not have.
  const totalLines = whole?.lines ?? (request.content.endsWith("\n") ? lines.length - 1 : lines.length);
  const kb = Math.max(1, Math.round((whole?.chars ?? request.content.length) / 1024));

  const headChars = Math.floor(budgetChars * HEAD_SHARE);
  const tailChars = budgetChars - headChars;
  const head = takeLines(lines, headChars, "head");
  // The tail may not reuse what the head took — one enormous line would otherwise be shown twice,
  // which is how a spilled excerpt came out *larger* than the output it replaced.
  const tail = takeLines(lines.slice(head.whole), tailChars, "tail");
  const hidden = Math.max(0, totalLines - head.count - tail.count);

  const header =
    `[output too large for the context: ${totalLines} lines, ~${kb}KB. ` +
    `The first ${head.count} and last ${tail.count} lines are below; ${hidden} in the middle are not.` +
    (head.cut || tail.cut ? " A line too long to show whole is cut and marked." : "") +
    "]";

  const where = path
    ? [
        `Full output: ${path}`,
        "Search it with `grep`, or `read` it with an offset and a limit: reading the whole file back " +
          "would only be cut down again.",
      ]
    : [
        "The full output could not be written to disk, so what is below is all that is left of it.",
        "Run the tool again, narrowed or piped through `head`, `tail` or `grep`, if you need the rest.",
      ];

  return [
    header,
    ...where,
    "",
    `--- first ${head.count} lines ---`,
    head.text,
    "",
    `--- last ${tail.count} lines ---`,
    tail.text,
  ].join("\n");
}

/**
 * As many whole lines from one end as fit in `budget` characters.
 *
 * Whole lines, because the excerpt is the only shape the model has to reason about and a fragment
 * ending mid-token reads as corruption. The exception is a single line longer than the whole budget —
 * minified JSON, a base64 blob — which is cut, at a character boundary, and says so. Returning it
 * whole was the old behaviour and it ignored the budget entirely.
 *
 * `whole` is how many lines were consumed from the source end, so the other end can skip them.
 */
function takeLines(
  lines: string[],
  budget: number,
  end: "head" | "tail",
): { text: string; count: number; whole: number; cut: boolean } {
  const source = end === "head" ? lines : [...lines].reverse();
  const taken: string[] = [];
  let used = 0;
  let cut = false;

  for (const line of source) {
    const cost = line.length + 1;
    if (used + cost <= budget) {
      taken.push(line);
      used += cost;
      continue;
    }
    // Only the first line may be cut: past it there are whole lines already, and a partial one after
    // them would be a fragment for no reason.
    if (taken.length === 0 && budget > 0) {
      taken.push(cutLine(line, budget, end));
      cut = true;
    }
    break;
  }

  const ordered = end === "head" ? taken : taken.reverse();
  return { text: ordered.join("\n"), count: ordered.length, whole: cut ? 0 : taken.length, cut };
}

const CUT_MARK = " […line continues]";

/** One line cut to `budget`, never through a surrogate pair. */
function cutLine(line: string, budget: number, end: "head" | "tail"): string {
  const room = Math.max(1, budget - CUT_MARK.length);
  if (end === "head") {
    let stop = room;
    if (isLowSurrogate(line.charCodeAt(stop))) stop -= 1;
    return line.slice(0, stop) + CUT_MARK;
  }
  let start = line.length - room;
  if (isLowSurrogate(line.charCodeAt(start))) start += 1;
  return `[line began earlier…] ${line.slice(start)}`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * A path segment built from an id the daemon did not choose.
 *
 * A session id is derived from a chat id, and a chat id is whatever the platform hands over — a
 * WhatsApp JID has an `@`, and nothing stops a future one containing a `/` or a `..`. Neither belongs
 * in a filename, and the second is a directory traversal in the one place that writes with the
 * daemon's own privileges.
 */
function safeSegment(id: string): string {
  const cleaned = id
    .replace(/[^A-Za-z0-9._-]/g, "_")
    // Any run of dots collapses to one underscore. Stripping only a *leading* run left `a/../b` as
    // `a_.._b`, which is contained and safe — the separator is gone — but leaves a `..` in a path
    // built from untrusted input, and "safe because of how it is joined" is a property the next edit
    // to this function can quietly remove.
    .replace(/\.{2,}/g, "_");
  return cleaned.slice(0, 120) || "unknown";
}
