/**
 * `glob` and `grep` — finding things, as opposed to reading a path someone already knew.
 *
 * The gap was observed rather than assumed. Asked to look at what was in its workspace, an agent with
 * `read` and nothing else answered: *"Tool yang tersedia hanya `read` — tidak ada `ls`, `find`, atau
 * sejenisnya, jadi saya tidak bisa menelusuri semua path secara otomatis."* It was right. `read` needs
 * a path, and nothing could produce one.
 *
 * `exec` is not the answer for this. `find` is deliberately absent from the default exec allowlist
 * (`-delete` and `-exec` make it an arbitrary-mutation tool), so under `mode = "allowlist"` the agent
 * is genuinely stuck — and even under `full`, discovery would spend an approval prompt on something
 * that is only ever a read.
 *
 * Both tools are **read-only and need no approval**, and both are bounded in three directions: the
 * number of results, the bytes scanned per file, and the workspace roots they may look inside.
 * Unbounded output here does not error — it silently fills the context window, which is worse.
 */

import { globFiles, join, readTextFile, relative, resolveWithin, statFile } from "@nouride/runtime";
import { createLogger, type Tool, type ToolContext, type ToolResult } from "@nouride/shared";
import { expandAgentHome, rootsFor } from "@/modules/tools/builtins/files.ts";
import { credentialKind, maskCredentials } from "@/modules/tools/credential-files.ts";
import { hostReadRoots } from "@/modules/toolchain/facts.ts";

const log = createLogger("tools.search");

/** Enough to be useful in a prompt, small enough that a wrong pattern is a nuisance not a disaster. */
const MAX_GLOB_RESULTS = 200;
/** Beyond this, ask for the file. */
const MAX_GREP_CONTEXT = 10;

const MAX_GREP_MATCHES = 100;

/**
 * Patterns one `grep` may look for at once.
 *
 * A ceiling because the match budget is shared: twenty patterns against a hundred matches gives each
 * of them five, which is not a search result. Five covers what a person actually asks for — a symbol
 * and its two aliases, three error strings — and keeps every pattern's answer legible.
 */
const MAX_GREP_PATTERNS = 5;
/** Files bigger than this are skipped by `grep`: they are minified bundles or data, not source. */
const MAX_GREP_FILE_BYTES = 512 * 1024;
/** Cap on files opened in one `grep`, so a broad pattern cannot turn into a filesystem scan. */
const MAX_GREP_FILES = 2000;

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

/**
 * Roots the agent may look in, widest first.
 *
 * `workspaceRoots` already carries the agent's own directory plus anything declared, plus this turn's
 * attachment directory. Searching all of them is right: "the file I sent you" and "the file in the
 * project" are both things a person means without saying which root it is in.
 */
function rootsOf(ctx: ToolContext): string[] {
  // Read-mode: discovery follows what `read` can open, or `glob` returns paths the very next call
  // refuses. That mismatch is the shape of bug this codebase has hit twice — a tool naming a file the
  // sandbox will not hand over.
  return rootsFor(ctx, "read");
}

/** Absolute path back to something short enough to read in a chat, and rooted so `read` accepts it. */
function displayPath(root: string, match: string): string {
  return join(root, match);
}

export const globTool: Tool = {
  requiresApproval: false,
  // Read-only, and the whole point of it is being asked several things at once.
  parallelSafe: true,
  definition: {
    name: "glob",
    description:
      "Find files by name pattern across your workspace. Supports * and ** (e.g. '**/*.ts', 'docs/*.md'). Returns paths you can pass to read.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.md'" },
        path: {
          type: "string",
          description: "Directory to search under. Defaults to all of your workspace.",
        },
      },
      required: ["pattern"],
    },
  },

  async execute(args, ctx) {
    if (typeof args.pattern !== "string" || !args.pattern.trim()) {
      return fail("`pattern` must be a non-empty glob, e.g. '**/*.ts'.");
    }

    // A pattern is not a path, so it never goes through `resolveWithin` — but `path` does, and that is
    // the one an agent could aim outside the workspace.
    const roots = searchRoots(args.path, ctx);
    if ("error" in roots) return fail(roots.error);

    const found: string[] = [];
    let truncated = false;

    for (const root of roots.paths) {
      const remaining = MAX_GLOB_RESULTS - found.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const result = await globFiles(args.pattern, root, remaining);
      found.push(...result.paths.map((match) => displayPath(root, match)));
      if (result.truncated) truncated = true;
    }

    if (found.length === 0) {
      // Naming where it looked turns a dead end into a next step: the usual cause is a pattern
      // anchored at the wrong level, and the agent can see that from the roots.
      return {
        content: `No files matched \`${args.pattern}\`. Searched: ${roots.paths.join(", ")}.`,
        isError: false,
      };
    }

    log.debug("glob", { pattern: args.pattern, matches: found.length });
    return {
      content: [
        `${found.length}${truncated ? "+" : ""} file(s) matching \`${args.pattern}\`:`,
        ...found,
        ...(truncated ? [`[stopped at ${MAX_GLOB_RESULTS}: narrow the pattern to see the rest]`] : []),
      ].join("\n"),
      isError: false,
      metadata: { count: found.length, truncated },
    };
  },
};

export const grepTool: Tool = {
  requiresApproval: false,
  // Read-only, and the whole point of it is being asked several things at once.
  parallelSafe: true,
  definition: {
    name: "grep",
    description:
      "Search file contents across your workspace. Returns matching lines with their file and line " +
      "number. Pass `patterns` to look for several things in ONE call: the files are read once for " +
      "all of them, so it is cheaper than one call per pattern in both time and round trips. Set " +
      "`context` to see surrounding lines: a match in a log or a stack trace usually means nothing on " +
      "its own. Pass `glob` to narrow which files are searched.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or regular expression to find" },
        patterns: {
          type: "array",
          items: { type: "string" },
          description: `Several patterns, searched in one pass (up to ${MAX_GREP_PATTERNS}). Prefer this whenever you are looking for more than one thing.`,
        },
        glob: {
          type: "string",
          description: "Only search files matching this glob, e.g. '**/*.ts'. Defaults to all files.",
        },
        path: { type: "string", description: "Directory to search under. Defaults to your workspace." },
        case_sensitive: { type: "boolean", description: "Defaults to false" },
        context: {
          type: "integer",
          description:
            "Lines of surrounding context to include with each match, like grep -C. Defaults to 0.",
        },
      },
    },
  },

  async execute(args, ctx) {
    /**
     * One pattern or several, compiled once.
     *
     * `patterns` exists for the reason `read`'s `paths` does — the measured median was 1.00 tool calls
     * per model round trip, and each round trip re-sends the whole conversation — but it buys something
     * `read` does not: the files are read **once** for every pattern instead of once per call. Three
     * symbols across a repository used to be three full passes over the tree.
     */
    const wanted = Array.isArray(args.patterns)
      ? (args.patterns as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      : typeof args.pattern === "string" && args.pattern.trim()
        ? [args.pattern]
        : [];

    if (wanted.length === 0) return fail("Pass `pattern` for one thing to find, or `patterns` for several.");
    if (wanted.length > MAX_GREP_PATTERNS) {
      return fail(`${wanted.length} patterns, and the limit is ${MAX_GREP_PATTERNS} per call.`);
    }

    const flags = args.case_sensitive === true ? "" : "i";
    const regexes: { source: string; regex: RegExp }[] = [];
    for (const source of wanted) {
      try {
        regexes.push({ source, regex: new RegExp(source, flags) });
      } catch (err) {
        // Returned as a result, not thrown: the model wrote the pattern and can fix it, and the error
        // from the engine says exactly what is wrong with it. Named, because with several patterns
        // "one of them is invalid" is not enough to fix it.
        return fail(`\`${source}\` is not a valid regular expression: ${String(err)}`);
      }
    }

    const roots = searchRoots(args.path, ctx);
    if ("error" in roots) return fail(roots.error);

    const filePattern = typeof args.glob === "string" && args.glob.trim() ? args.glob : "**/*";
    // Capped rather than refused: a model that asks for 500 lines of context wants the file, and
    // handing it back through a match list is the expensive way to read one.
    const context =
      typeof args.context === "number" && Number.isFinite(args.context)
        ? Math.min(MAX_GREP_CONTEXT, Math.max(0, Math.trunc(args.context)))
        : 0;
    const matches: string[] = [];
    /** Which patterns hit something, so the ones that did not can be said out loud. */
    const found = new Set<string>();
    let filesScanned = 0;
    let truncated = false;

    for (const root of roots.paths) {
      const { paths } = await globFiles(filePattern, root, MAX_GREP_FILES);

      for (const relativePath of paths) {
        if (matches.length >= MAX_GREP_MATCHES) {
          truncated = true;
          break;
        }

        const absolute = join(root, relativePath);
        // Skipped rather than truncated: a match at byte 900,000 of a minified bundle is not something
        // anyone asked for, and reading it costs the whole file.
        const stat = statFile(absolute);
        if (!stat || stat.isDirectory || stat.size > MAX_GREP_FILE_BYTES) continue;

        // Searched as `read` would show them: Nouride's own secrets not at all, other credential files
        // with their values hidden — so a pattern cannot find a secret one guessed character at a time.
        const kind = credentialKind(absolute);
        if (kind === "own") continue;
        let text: string;
        try {
          text = await readTextFile(absolute);
          if (kind) text = maskCredentials(absolute, text).text;
        } catch {
          // Binary, unreadable, or deleted between the glob and the read. Not worth reporting: the
          // agent asked about content, and a file with none is simply not a match.
          continue;
        }
        filesScanned += 1;

        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_GREP_MATCHES) {
            truncated = true;
            break;
          }
          const line = lines[i] ?? "";
          // The first pattern that matches labels the line. A line matching two of them is one line,
          // and reporting it twice would spend the shared match budget on a duplicate.
          const hit = regexes.find((candidate) => candidate.regex.test(line));
          if (!hit) continue;
          found.add(hit.source);

          const where = relative(root, absolute);
          const label = regexes.length > 1 ? `[${hit.source}] ` : "";
          if (context === 0) {
            // Long lines are clipped per line rather than dropped: the file and line number are the
            // useful part, and a 4,000-character match would crowd out every other result.
            matches.push(`${label}${where}:${i + 1}: ${line.trim().slice(0, 200)}`);
            continue;
          }

          // A match in a log or a stack trace is rarely the interesting line — the interesting one is
          // just above or below it. Rendered as a block with the match marked, so the model can tell
          // which line it actually asked about.
          const from = Math.max(0, i - context);
          const to = Math.min(lines.length - 1, i + context);
          const block: string[] = [`${label}${where}:${i + 1}:`];
          for (let n = from; n <= to; n += 1) {
            const mark = n === i ? ">" : " ";
            block.push(`  ${mark} ${n + 1} | ${(lines[n] ?? "").slice(0, 200)}`);
          }
          matches.push(block.join("\n"));
        }
      }
    }

    const quoted = wanted.map((source) => `\`${source}\``).join(", ");

    if (matches.length === 0) {
      return {
        content: `No matches for ${quoted} in ${filesScanned} file(s) under ${roots.paths.join(", ")}.`,
        isError: false,
      };
    }

    /**
     * Which patterns found nothing.
     *
     * The information a model would otherwise spend a whole round trip discovering: with five patterns
     * and one list of matches, "my third pattern is wrong" and "my third pattern has no matches" look
     * identical, and both invite a retry.
     */
    const missing = wanted.filter((source) => !found.has(source));

    log.debug("grep", { patterns: wanted.length, matches: matches.length, files: filesScanned });
    return {
      content: [
        `${matches.length}${truncated ? "+" : ""} match(es) for ${quoted} in ${filesScanned} file(s):`,
        ...matches,
        ...(missing.length > 0
          ? [`[no matches at all for: ${missing.map((source) => `\`${source}\``).join(", ")}]`]
          : []),
        ...(truncated
          ? [`[stopped at ${MAX_GREP_MATCHES} matches: narrow the pattern or pass a glob]`]
          : []),
      ].join("\n"),
      isError: false,
      metadata: {
        matches: matches.length,
        filesScanned,
        truncated,
        ...(missing.length > 0 ? { withoutMatches: missing } : {}),
      },
    };
  },
};

/**
 * Which directories this call searches.
 *
 * One shape for both branches — an earlier version returned a bare array when no `path` was given and
 * an object when one was, which typechecked at neither call site.
 */
function searchRoots(
  requested: unknown,
  ctx: ToolContext,
): { paths: string[] } | { error: string } {
  // HOME and the install's own program directories are opened by path only: a search with no path
  // would otherwise crawl gigabytes of tool caches and node_modules looking for a project file.
  if (requested === undefined) {
    const byPathOnly = hostReadRoots();
    return { paths: rootsOf(ctx).filter((root) => !byPathOnly.includes(root)) };
  }
  return resolveRequested(requested, ctx);
}

/**
 * A requested directory, checked against every root.
 *
 * Same rule as `exec`'s cwd: resolved first and compared afterwards, so `../` and absolute spellings
 * normalize before the check and cannot be walked around by spelling the path differently.
 */
function resolveRequested(
  requested: unknown,
  ctx: ToolContext,
): { paths: string[] } | { error: string } {
  if (typeof requested !== "string") return { error: "`path` must be a string." };
  // `~/` as `read` takes it — HOME is a root by path for an agent with a shell (`hostReadRoots`).
  const path = expandAgentHome(ctx, requested);

  for (const root of rootsOf(ctx)) {
    try {
      return { paths: [resolveWithin(root, path)] };
    } catch {
      // Not under this root — try the next.
    }
  }
  return {
    error: `\`${requested}\` is outside the directories you may use: ${rootsOf(ctx).join(", ")}.`,
  };
}
