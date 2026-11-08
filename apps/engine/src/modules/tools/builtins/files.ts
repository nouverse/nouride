/**
 * File tools: `read`, `write`, `edit`.
 *
 * Every path argument goes through `resolveWithin(ctx.workspaceDir, …)`, which is the
 * sandbox boundary (§7.1 SPEC): the agent's own directory is its workspace, and a path
 * that resolves outside it is refused rather than clamped.
 */

import { agentCommandsHaveOwnUsers, basename, dirname, expandHome, fileExists, join, readHeadBytes, readTextFile, realPath, resolveWithin, statFile } from "@nouride/runtime";
import { binaryReadMessage, documentKindFor, documentReadMessage, looksBinary } from "./document-kind.ts";
import { lookAt, viewableImage, type ReadImages } from "./read-image.ts";
import { ToolError, toUserMessage, type Tool, type ToolContext, type ToolResult } from "@nouride/shared";
import { withFileLock } from "@/commons/file-lock.ts";
import { writeAgentFile } from "@/modules/tools/agent-files.ts";
import { isOwnPersona, OWN_PERSONA_REFUSAL } from "@/modules/tools/persona-files.ts";
import { diagnoseEditMiss } from "@/modules/tools/builtins/edit-diagnostics.ts";
import { parseEdits } from "@/modules/tools/builtins/edit-list.ts";
import { credentialKind, maskCredentials, ownSecretRefusal } from "@/modules/tools/credential-files.ts";

// The write lock lives in its own module so `memory.ts` and the dashboard's file editor hold the same
// instance. See `file-lock.ts` for what went wrong while each caller made its own.

/**
 * Paths this process has read, per agent.
 *
 * `write` refuses to **overwrite** a file nobody has read. Claude Code enforces the same rule, and the
 * reason is asymmetry: `edit` has a built-in guard, because a wrong `old_string` simply does not match
 * and nothing happens. `write` has none — it replaces the whole file, so an agent that half-remembers a
 * 5,000-line config can obliterate it in one call and the only record is the audit log.
 *
 * Keyed by agent as well as path: one agent having read a file says nothing about what another knows,
 * and two agents can share a workspace root.
 *
 * In memory, so a restart clears it. That is the safe direction — after a restart nothing has been read
 * in this process, so an overwrite asks for a read first.
 *
 * Capped to prevent unbounded growth over weeks of uptime. Clearing the set when it overflows is safe:
 * the only consequence is that the next write without a prior read gets one extra "read the file first"
 * refusal — a minor friction, not a correctness issue.
 */
const READ_PATHS_CAP = 10_000;
const readPaths = new Set<string>();

function markRead(agentId: string, path: string): void {
  if (readPaths.size >= READ_PATHS_CAP) readPaths.clear();
  readPaths.add(`${agentId}\u0000${path}`);
}

function hasRead(agentId: string, path: string): boolean {
  return readPaths.has(`${agentId}\u0000${path}`);
}

/** Output cap per read, so one large file cannot fill the context window. */
const MAX_READ_BYTES = 256 * 1024;

/**
 * Files one `read` may take at once.
 *
 * A ceiling because the whole point is fewer round trips, and "read the repository" is not a request
 * this tool should try to answer — it is `glob` followed by a decision. Ten covers every real case
 * (a module and its tests, a config and the file that loads it) and keeps one call's output legible.
 */
const MAX_READ_PATHS = 10;

/**
 * How much of a file's head is sniffed for a NUL byte before decoding it.
 *
 * 4 KB. Every real binary format puts something un-textual in its first block, and the cost is one
 * partial read rather than pulling a whole file into memory to discover it is unreadable.
 */
const HEAD_SNIFF_BYTES = 4096;

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, isError: false, ...(metadata ? { metadata } : {}) };
}

function fail(content: string): ToolResult {
  // Errors come back as tool *results*, not exceptions: the model reads them and adapts,
  // which is a better recovery path than aborting the turn (§6.2 SPEC).
  return { content, isError: true };
}

/**
 * Exported so an approval preview resolves a path exactly as the write will.
 *
 * Resolving it differently would be worse than not previewing: the summary would describe a different
 * file from the one about to change, and "new file" for a path that already exists is the one mistake
 * this summary must never make.
 */
export function resolveToolPath(ctx: ToolContext, raw: unknown, field: string): string {
  return resolve(ctx, raw, field);
}

/**
 * Every directory this call may touch.
 *
 * `read` sees one more list than `write` and `edit` do: a background job's log is something the agent
 * has to be able to follow and must not be able to truncate while the job is still writing it.
 */
export function rootsFor(ctx: ToolContext, mode: "read" | "write"): string[] {
  const writable = ctx.workspaceRoots.length > 0 ? ctx.workspaceRoots : [ctx.workspaceDir];
  return mode === "read" ? [...writable, ...(ctx.readOnlyRoots ?? [])] : writable;
}

/**
 * Resolve a model-supplied path inside one of the agent's roots.
 *
 * Tried against every root rather than only `workspaceDir`: an agent with declared project roots
 * has to reach them, and a relative path is interpreted against its own directory first so
 * existing behaviour is unchanged for agents with no roots configured.
 */
function resolve(ctx: ToolContext, given: unknown, field: string, mode: "read" | "write" = "write"): string {
  if (typeof given !== "string" || !given.trim()) {
    throw new ToolError("files", `${field} is required`, `\`${field}\` must be a path.`);
  }
  // `~/` is what people type and what installers print; resolved against a root it was `<root>/~/...`.
  const raw = expandAgentHome(ctx, given);

  const roots = rootsFor(ctx, mode);
  for (const root of roots) {
    let path: string;
    try {
      path = resolveWithin(root, raw);
    } catch {
      continue; // Not under this root — try the next.
    }
    if (mode === "write" && governsAgents(ctx, path)) {
      throw new ToolError("files", `config write refused: ${raw}`, OWN_CONFIG_REFUSAL);
    }
    if (mode === "write" && isOwnPersona(ctx.agentDir, path)) {
      throw new ToolError("files", `persona write refused: ${raw}`, OWN_PERSONA_REFUSAL);
    }
    return path;
  }

  // A path that would have resolved for a read says so, rather than reporting the same "outside the
  // directories you may use" for two different situations — one of which the agent can act on by
  // reading instead of writing.
  const readable = mode === "write" && rootsFor(ctx, "read").some((root) => canResolve(root, raw));
  throw new ToolError(
    "files",
    `path escapes workspace: ${raw}`,
    readable
      ? `\`${raw}\` is readable but not writable.`
      : // The way that works, named. Refused with nothing else, the next call was the same read through
        // `exec` anyway — or a script — so the refusal only cost a round trip and taught nothing.
        `Path \`${raw}\` is outside the directories these file tools open (${roots.length} configured). If you can run` +
          " commands, read it with `exec` (`cat`, `head`, `sed -n`): that is the way for a file out here, not a workaround." +
          " To send one, copy it into $TMPDIR first.",
  );
}

/**
 * `~/` as the agent's commands have it: its own folder where each agent is its own user (`ownHomeEnv`), the daemon's
 * HOME otherwise. Read as the daemon's there, `write ~/.ssh/config` was refused as outside the workspace — the file its
 * own ssh reads.
 */
export function expandAgentHome(ctx: Pick<ToolContext, "privateDir">, path: string): string {
  if (!path.startsWith("~/")) return path;
  return agentCommandsHaveOwnUsers() && ctx.privateDir ? join(ctx.privateDir, path.slice(2)) : expandHome(path);
}

/**
 * Whether `path` is a config that decides what agents may do: this agent's own pack `config.toml`, or
 * the daemon's.
 *
 * The pack is a workspace root so the agent can keep `MEMORY.md`, and that made its `config.toml`
 * writable too — found live: an agent rewrote its own to widen its workspace roots, with no prompt at
 * all. Tools, roots, approvals and credentials are the operator's to change. Refused at every approval
 * level, because "nothing asks" is a setting the same file holds.
 */
function governsAgents(ctx: ToolContext, path: string): boolean {
  // Compared resolved, because `path` is: a pack reached through a symlink is the same pack.
  const own = realPath(join(ctx.agentDir, "config.toml"));
  const daemon = process.env.NOURIDE_BIN ? realPath(join(dirname(process.env.NOURIDE_BIN), "config.toml")) : null;
  return path === own || path === daemon;
}

const OWN_CONFIG_REFUSAL =
  "That config decides what agents may do (tools, roots, approvals, credentials), and it is the operator's to change," +
  " from the dashboard or `nouride` CLI. Do not change it another way: say what should change and why.";

function canResolve(root: string, raw: string): boolean {
  try {
    resolveWithin(root, raw);
    return true;
  } catch {
    return false;
  }
}

/** `read`, and with `images` it shows a picture rather than refusing it as binary (`read-image.ts`). */
export function createReadTool(images?: ReadImages): Tool {
  return {
  requiresApproval: false,
  // A read cannot interfere with another read. See `Tool.parallelSafe`.
  parallelSafe: true,
  // A file's lines, kept exactly: an edit is made by the text read. See `Tool.verbatim`.
  verbatim: true,
  definition: {
    name: "read",
    description:
      "Read UTF-8 text files from your workspace. Pass `paths` to read several in ONE call: that is " +
      "always cheaper than calling this once per file, because every extra call re-sends the whole " +
      "conversation. Use `path` with `offset`/`limit` when you want a slice of one file. A whole-file " +
      `read is capped at ${MAX_READ_BYTES / 1024}KB; page through a larger file with offset/limit. ` +
      (images ? "Images are shown as pictures; PDFs, Office files and other binaries" : "PDFs, Office files, images and other binaries") +
      " are refused, with the command that converts them.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "One path, relative to your workspace or absolute" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: `Several paths, read in one call (up to ${MAX_READ_PATHS}). Prefer this whenever you want more than one file. Cannot be combined with offset/limit.`,
        },
        offset: { type: "integer", description: "First line to return (1-based). Single path only." },
        limit: { type: "integer", description: "Maximum number of lines to return. Single path only." },
      },
    },
  },
  async execute(args, ctx) {
    /**
     * Several files, or one.
     *
     * `paths` exists because the model's own numbers said it should. Measured on a live daemon: the
     * median turn asked for **1.00 tool calls per model round trip**, and a turn that batched five
     * reads into one message cost 63k input tokens where the same five, one at a time, cost 151k and
     * took 2.4x as long. The executor could already run parallel-safe calls together — what it could
     * not do is make the model *ask* that way. An array parameter is a shape a model reaches for; four
     * copies of the same tool in one message is a habit it has to remember.
     */
    const many = Array.isArray(args.paths)
      ? (args.paths as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [];
    if (many.length > 0) return await readMany(many, args, ctx, images);
    if (typeof args.path !== "string" || !args.path.trim()) {
      return fail("Pass `path` for one file, or `paths` for several.");
    }
    return await readOne(args.path, args, ctx, images);
  },
  };
}

/**
 * One file, with every guard it has always had.
 *
 * Split out of `execute` so the many-file path cannot drift from it — a second reader that forgot the
 * document check or the size ceiling would be a second set of failures to discover.
 */
async function readOne(
  rawPath: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  images?: ReadImages,
): Promise<ToolResult> {
    const path = resolve(ctx, rawPath, "path", "read");
    // Nouride's own secrets are refused; any other credential file is read with its values hidden.
    if (credentialKind(path) === "own") return fail(ownSecretRefusal(rawPath));
    const stat = statFile(path);
    if (!stat) return fail(`No such file: ${rawPath}`);
    if (stat.isDirectory) return fail(`${rawPath} is a directory, not a file.`);
    // A picture is looked at, not decoded — before the text ceiling, which a screenshot is usually over.
    const picture = images ? viewableImage(path) : null;
    if (images && picture) return await lookAt(images, ctx, { path, shown: rawPath, size: stat.size, mimeType: picture });

    const offset = typeof args.offset === "number" ? Math.max(1, Math.trunc(args.offset)) : 1;
    const limit = typeof args.limit === "number" ? Math.max(1, Math.trunc(args.limit)) : undefined;
    const windowed = offset > 1 || limit !== undefined;

    /**
     * The cap is on what is **returned**, not on what the file weighs.
     *
     * It used to be on the file: over 256KB, refused outright — with a message telling the agent to
     * "use offset and limit", which this same check then ignored. So the remedy it named was
     * unreachable, and the failure was worse than a plain refusal because the advice looked actionable.
     *
     * Found live, and by the feature that made it matter: `llm/spill.ts` writes a tool result too big
     * for the context to disk and hands the model a path with exactly that instruction. Every spill
     * worth making is larger than 256KB, so every one of those pointers was dead on arrival.
     *
     * A windowed read is now allowed at any file size and capped on the slice; a whole-file read keeps
     * the old ceiling, because "give me all of it" on a 6MB file is the request the ceiling exists to
     * refuse.
     */
    if (!windowed && stat.size > MAX_READ_BYTES) {
      return fail(
        `File is ${Math.round(stat.size / 1024)}KB, over the ${MAX_READ_BYTES / 1024}KB whole-file read limit. ` +
          `Pass offset and limit to read part of it: a windowed read has no size limit on the file, only on what it returns.`,
      );
    }

    /**
     * A document is refused before it is decoded, with the first command to run instead.
     *
     * Before this the bytes came back as mojibake — sometimes plausible-looking mojibake — and the
     * agent had to work out on its own both what it was holding and what opens it. See
     * `document-kind.ts` for what was watched happening instead.
     *
     * Checked after the size guard so a 40 MB PDF still gets the size message, which is the more
     * actionable of the two.
     */
    const document = documentKindFor(path);
    if (document) return fail(documentReadMessage(rawPath, document));

    /**
     * And a binary file that arrived without a telling name.
     *
     * The head only — `HEAD_SNIFF_BYTES` is enough for a NUL to show up in anything that is really
     * binary, and reading the whole file to find out it is unreadable is the cost this avoids on a
     * large one.
     */
    if (looksBinary(await readHeadBytes(path, HEAD_SNIFF_BYTES))) {
      return fail(binaryReadMessage(rawPath));
    }

    const { text, note } = maskCredentials(path, await readTextFile(path));
    // Recorded even for a partial read: an agent that has seen part of a file has enough context to
    // know it is replacing something, which is the judgement the write guard is protecting.
    markRead(ctx.agentId, path);

    if (!windowed) {
      return ok(`${text}${note}`, { bytes: stat.size });
    }

    const lines = text.split("\n");
    const slice = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit);
    const joined = slice.join("\n");

    // A window with no `limit` on a huge file is still a whole-file read in disguise. Capped on the
    // returned bytes rather than refused, because the offset says the agent knows where it is going.
    if (joined.length > MAX_READ_BYTES) {
      const kept = joined.slice(0, MAX_READ_BYTES);
      const keptLines = kept.split("\n").length;
      return ok(
        `${kept}\n[cut at the ${MAX_READ_BYTES / 1024}KB read limit after ${keptLines} lines; continue with offset ${offset + keptLines - 1}]`,
        { lines: keptLines, totalLines: lines.length, truncated: true },
      );
    }

    return ok(`${joined}${note}`, { lines: slice.length, totalLines: lines.length });
}

/** Headings and notes around the files of a batch, kept out of what the files themselves may use. */
const READ_FRAME_CHARS = 1_000;

/**
 * Several files in one result.
 *
 * Three decisions, and each one is about what a model does with the answer:
 *
 * - **A file that cannot be read does not fail the call.** Four paths where one is missing returns the
 *   other three and says so. Refusing the lot would make the model retry them one at a time, which is
 *   exactly the behaviour this parameter exists to remove.
 * - **One combined byte budget**, not a limit per file. Ten files at the single-file ceiling would be
 *   2.5MB in one tool result; the budget is the same ceiling for the whole call, and what did not fit
 *   is named so the model can come back for it.
 * - **Every file is headed by its path.** Without that the contents run together and the model
 *   attributes a line to the wrong file, which is worse than not having read it.
 */
async function readMany(
  paths: string[],
  args: Record<string, unknown>,
  ctx: ToolContext,
  images?: ReadImages,
): Promise<ToolResult> {
  if (args.offset !== undefined || args.limit !== undefined) {
    return fail(
      "`offset` and `limit` describe one file. Read the slice with `path`, or drop them and pass `paths`.",
    );
  }
  if (paths.length > MAX_READ_PATHS) {
    return fail(
      `${paths.length} paths, and the limit is ${MAX_READ_PATHS} per call. Read the most important ones first, or narrow with \`glob\` or \`grep\`.`,
    );
  }

  const seen = new Set<string>();
  const sections: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const pictures: NonNullable<ToolResult["media"]> = [];
  let used = 0;
  /**
   * The smaller of the read ceiling and what the model will actually see of this result.
   *
   * The ceiling alone was wrong in a way nothing reported: ten files read to 256KB came back through
   * the spill as a head and a tail, so the files in the middle were read, paid for, and then cut out
   * of the excerpt — while the list of sections told the model it had all ten. Stopping at the
   * visible budget names those files as not read instead, which is something the model can act on.
   */
  const budget = Math.min(MAX_READ_BYTES, ctx.resultChars === undefined ? MAX_READ_BYTES : ctx.resultChars - READ_FRAME_CHARS);

  for (const raw of paths) {
    // A path repeated in one call is read once. The model sometimes lists the same file twice when it
    // assembles the array from two thoughts, and paying for it twice is pure waste.
    if (seen.has(raw)) continue;
    seen.add(raw);

    if (used >= budget) {
      skipped.push(raw);
      continue;
    }

    /**
     * A path that *throws* is a failed file, not a failed call.
     *
     * `resolve` throws for anything outside the agent's roots, and the single-file path is right to let
     * that propagate — the whole call was that one file. In a batch it would discard the files that
     * were fine, which sends the model straight back to one call per file. Caught by the test that
     * mixed a good path with `/etc/passwd`.
     */
    let result: ToolResult;
    try {
      result = await readOne(raw, {}, ctx, images);
    } catch (err) {
      failed.push(`${raw}: ${toUserMessage(err)}`);
      continue;
    }

    const body = String(result.content ?? "");
    if (result.isError) {
      failed.push(`${raw}: ${body}`);
      continue;
    }

    const room = budget - used;
    const kept =
      body.length > room
        ? `${body.slice(0, room)}\n[cut at the read budget for this call; read this file on its own, with offset and limit, for the rest]`
        : body;
    used += kept.length;
    sections.push(`===== ${raw} =====\n${kept}`);
    pictures.push(...(result.media ?? []));
  }

  const notes: string[] = [];
  if (failed.length > 0) notes.push(`Could not read:\n${failed.map((line) => `- ${line}`).join("\n")}`);
  if (skipped.length > 0) {
    notes.push(
      `Not read, since this call reached its ${Math.round(budget / 1024)}KB budget: ${skipped.join(", ")}. Read them in another call.`,
    );
  }

  if (sections.length === 0) {
    return fail(notes.join("\n\n") || "Nothing was read.");
  }

  const read = ok([...sections, ...notes].join("\n\n"), {
    files: sections.length,
    ...(failed.length > 0 ? { failed: failed.length } : {}),
    ...(skipped.length > 0 ? { skipped: skipped.length } : {}),
    bytes: used,
  });
  return pictures.length > 0 ? { ...read, media: pictures } : read;
}

/** What a writing tool's `path` takes — `resolve` accepts an absolute path inside any workspace root. */
const PATH_IN_WORKSPACE = "Path relative to your workspace, or absolute inside one of your workspace roots";

/** The daemon's `config.toml`, or an agent pack's — what decides what agents may do. */
const CONFIG_FILE = /(^|\/)\.nouride\/(agents\/[^/]+\/)?config\.toml$/;

/**
 * A write to a `config.toml` that decides what agents may do is on the fixed list (`config`), whichever tool makes it.
 * Only where the agent writes as the daemon's user: where each agent is its own user, a pack is its agent's to read and
 * the daemon's to write, and the write is refused by the file's permissions before anybody would be asked.
 */
function writesConfig(args: Record<string, unknown>, ctx: ToolContext): { class: "config"; reason: string } | null {
  if (agentCommandsHaveOwnUsers()) return null;
  let path: string;
  try {
    path = resolve(ctx, args.path, "path");
  } catch {
    // Outside the agent's roots, or no path: the tool refuses it itself.
    return null;
  }
  return CONFIG_FILE.test(path) ? { class: "config", reason: `changes ${path}, which decides what agents may do` } : null;
}

export const writeTool: Tool = {
  requiresApproval: true,
  fixedList: writesConfig,
  definition: {
    name: "write",
    description:
      "Write a whole text file in your workspace, creating parent directories. Overwriting an existing " +
      "file is refused unless you have read it in this session; use edit or multi_edit for targeted changes. " +
      "For content too large for one call, write the first part, then call again with append: true for each next part.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: PATH_IN_WORKSPACE },
        content: { type: "string", description: "Full file contents; with append, the part to add at the end" },
        append: { type: "boolean", description: "Add content to the end of the file (created if missing) instead of replacing it" },
      },
      required: ["path", "content"],
    },
  },
  async execute(args, ctx) {
    const path = resolve(ctx, args.path, "path");
    if (typeof args.content !== "string") return fail("`content` must be a string.");
    const content = args.content;

    return await withFileLock(path, async () => {
      const existed = await fileExists(path);

      /**
       * A large file in parts (2026-10-21): a whole document in one call's arguments ran into the reply's output limit
       * and arrived cut, three times; the way round it was a shell heredoc, which no gate reads as a file write.
       * Appending replaces nothing, so it needs no read first — and marks nothing read: the agent has not seen the rest.
       */
      if (args.append === true) {
        const before = existed ? await readTextFile(path) : "";
        await writeAgentFile(ctx, path, before + content);
        return ok(
          `${existed ? "Appended to" : "Created"} ${basename(path)} (+${content.length} chars, ${before.length + content.length} in all).`,
          { path, existed, appended: true },
        );
      }

      // Creating is free; replacing is not. `write` swaps the whole file, so an agent working from a
      // half-remembered version can obliterate one in a single call. `edit` needs no equivalent guard —
      // a wrong `old_string` simply does not match and nothing happens.
      if (existed && !hasRead(ctx.agentId, path)) {
        return fail(
          `${basename(path)} already exists and you have not read it. Read it first, then write. ` +
            `Otherwise you would replace contents you have not seen. Use edit for a targeted change.`,
        );
      }

      await writeAgentFile(ctx, path, content);
      // A file this agent just wrote is one it has seen the contents of, so a follow-up write in the
      // same turn is not blind.
      markRead(ctx.agentId, path);
      return ok(
        `${existed ? "Overwrote" : "Created"} ${basename(path)} (${content.length} chars).`,
        { path, existed },
      );
    });
  },
};

export const editTool: Tool = {
  requiresApproval: true,
  fixedList: writesConfig,
  definition: {
    name: "edit",
    description:
      "Replace one exact string in a file: one change. For more than one change to the same file, use " +
      "`multi_edit` instead. Fails if the string is absent, or appears more than once and replace_all is not set.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: PATH_IN_WORKSPACE },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  async execute(args, ctx) {
    const path = resolve(ctx, args.path, "path");
    if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
      return fail("`old_string` and `new_string` must both be strings.");
    }
    if (args.old_string === args.new_string) {
      return fail("`old_string` and `new_string` are identical, so there is nothing to do.");
    }
    if (!(await fileExists(path))) return fail(`No such file: ${args.path as string}`);

    // The read and the write are one critical section. `edit` is read-modify-write, and two
    // agents can share a workspace root — so two turns could read the same file, both compute a result
    // from the pre-edit text, and the second write would silently discard the first. Atomic writes
    // do not help: each write is individually atomic and the *lost update* happens between them.
    //
    // `MEMORY.md` has had this since Phase 1 for the same reason. This is the debt that took four
    // mentions to pay.
    const oldString = args.old_string;
    const newString = args.new_string;
    const replaceAll = args.replace_all === true;

    return await withFileLock(path, async () => {
      const original = await readTextFile(path);
      const occurrences = countOccurrences(original, oldString);

      /**
       * The refusal says *why*, because the bare sentence sent the model back to guess.
       *
       * The matcher is unchanged and deliberately so — an exact match that refuses is the property
       * that makes a failed edit harmless, and it is the reason this repo has never corrupted a file
       * the way a fuzzy apply does. What was missing was the diagnosis: one space of indentation out
       * and the model had nothing to work from, so it retried blind. `diagnoseEditMiss` finds where
       * the text nearly matched and names the difference, which turns a dead end into one retry.
       */
      if (occurrences === 0) {
        return fail(`\`old_string\` was not found in the file.${diagnoseEditMiss(original, oldString)}`);
      }
      if (occurrences > 1 && !replaceAll) {
        // Refusing an ambiguous edit rather than picking the first match: a silent wrong
        // replacement in the wrong place is far harder to notice than an error here.
        return fail(
          `\`old_string\` appears ${occurrences} times. Include more surrounding context to make it unique, or set replace_all.`,
        );
      }

      const updated = replaceAll
        ? original.replaceAll(oldString, newString)
        : original.replace(oldString, newString);

      await writeAgentFile(ctx, path, updated);
      markRead(ctx.agentId, path);
      return ok(`Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${basename(path)}.`);
    });
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * `multi_edit` — several replacements in one file, all or nothing.
 *
 * Not a convenience wrapper. Three properties that a sequence of `edit` calls cannot have:
 *
 * - **One approval.** A refactor touching six places asked six times, and by the third prompt the
 *   operator is answering without reading — which is the failure mode the whole preview design exists
 *   to avoid. One prompt showing the whole change is a decision someone can actually make.
 * - **All or nothing.** Halfway through a sequence of `edit` calls, a file that no longer parses is
 *   the *saved* state. Applying every replacement to an in-memory copy and writing once means a
 *   failure leaves the file exactly as it was.
 * - **One critical section.** Six calls are six lock acquisitions with gaps between them, and the
 *   gaps are where another writer gets in.
 *
 * Edits apply in order, each to the result of the last, which is what lets a later edit depend on an
 * earlier one.
 */
export const multiEditTool: Tool = {
  requiresApproval: true,
  fixedList: writesConfig,
  definition: {
    name: "multi_edit",
    description:
      "Apply several exact-string replacements to one file in a single atomic change. Edits apply in " +
      "order, each to the result of the previous. If any one fails, nothing is written. Prefer this " +
      "over repeated edit calls on the same file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: PATH_IN_WORKSPACE },
        edits: {
          type: "array",
          description: "Replacements, applied in order. Each takes exact `old_string`, `new_string`, and optional `replace_all` (default false).",
          items: {
            type: "object",
            properties: { old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  async execute(args, ctx) {
    const path = resolve(ctx, args.path, "path");
    const edits = parseEdits(args.edits);
    if ("error" in edits) return fail(edits.error);
    if (!(await fileExists(path))) return fail(`No such file: ${args.path as string}`);

    return await withFileLock(path, async () => {
      const original = await readTextFile(path);
      let text = original;

      for (const [index, edit] of edits.list.entries()) {
        const occurrences = countOccurrences(text, edit.oldString);
        // Numbered, because "old_string was not found" is unhelpful when six were sent — and the
        // count is against the text *as edited so far*, which is the state the model has to reason
        // about when an earlier replacement consumed the text a later one was looking for.
        if (occurrences === 0) {
          // Diagnosed against `text`, the state *as edited so far*, not against the original — which
          // is the state a later edit actually has to match, and the one the numbered message above
          // already exists to point at.
          return fail(
            `Edit ${index + 1} of ${edits.list.length}: \`old_string\` was not found. Nothing was written.` +
              diagnoseEditMiss(text, edit.oldString),
          );
        }
        if (occurrences > 1 && !edit.replaceAll) {
          return fail(
            `Edit ${index + 1} of ${edits.list.length}: \`old_string\` appears ${occurrences} times. ` +
              `Add surrounding context or set replace_all. Nothing was written.`,
          );
        }
        text = edit.replaceAll
          ? text.replaceAll(edit.oldString, edit.newString)
          : text.replace(edit.oldString, edit.newString);
      }

      if (text === original) return fail("Those edits leave the file unchanged.");

      await writeAgentFile(ctx, path, text);
      markRead(ctx.agentId, path);
      return ok(`Applied ${edits.list.length} edit(s) to ${basename(path)}.`, {
        count: edits.list.length,
      });
    });
  },
};
