/**
 * Whether a coding CLI's delete stays inside its mission's own folder (0.8.7) — the one case its permission request is
 * answered without a person. Gading's decision of 2026-10-28: a mission cleaning up after itself (`rm -rf build`, a
 * scratch file, a helper's worktree) asked every time, and the person approved dozens of deletes they could not judge
 * from a chat. Inside the folder the daemon made for the mission, nothing outlives the mission anyway.
 *
 * The rule is narrow and every doubt is a question to the person, never an allow:
 *
 * - One simple command: `rm`, `rmdir`, `unlink` or `git worktree remove`, with flags this file knows. No chain (`;`, `&&`,
 *   `||`, `|`, `&`), no redirect, no subshell, no command substitution, no variable, no `~`, no glob, no brace — the
 *   shell would decide what those mean, and this reads only literal words.
 * - Every target is an absolute path, unless the request names its own absolute `cwd`: a CLI's shell keeps a `cd` from
 *   one call to the next (Claude Code's does), so the folder a relative path starts from is not something the daemon
 *   knows. The mission's page tells the agent to delete by absolute path.
 * - Every target is inside the mission's own folder twice over: as written (`..`
 *   collapsed) and as the real path, symlinks followed as the kernel follows them — a link before the `..` after it. A
 *   symlink that points outside is asked about, even where `rm` would only remove the link. A target that does not exist is judged by its parent's real path; no parent, asked.
 * - Never the folder itself, nor the mission's worktree: deleting those ends the mission's work, which is a person's call.
 *
 * Pure but for `real`, the real-path lookup, which a test replaces. Reviewed by Nox before 0.8.7 ships.
 */

import { basename, dirname, escapes, isAbsolute, join, realPathStrict, relative, resolve } from "@nouride/runtime";

export interface DeleteScope {
  /** Where a delete may land: the mission's own folder (its worktree is inside it). */
  roots: readonly string[];
  /** Folders that may not themselves go: the roots, and the mission's worktree. */
  keep: readonly string[];
  /** The real path of what exists, or null. Default: the filesystem's, with no lexical fallback. */
  real?: (path: string) => string | null;
}

export type DeleteVerdict = { inside: true; command: string; targets: string[] } | { inside: false; why: string };

/** What the CLI asked to run, as its permission request carries it. */
export interface DeleteRequest {
  kind?: string | null;
  rawInput?: unknown;
}

const no = (why: string): DeleteVerdict => ({ inside: false, why });

/** Characters the shell would act on outside quotes — any of them, and this does not guess what the shell would do. */
const UNQUOTED_SPECIAL = new Set([";", "&", "|", "<", ">", "(", ")", "`", "$", "{", "}", "*", "?", "[", "]", "!", "~", "#", "\n", "\r", "\\"]);
/** Inside double quotes the shell still expands these. */
const DOUBLE_SPECIAL = new Set(["$", "`", "\\", "!"]);

/** A command line as literal words, or null when anything in it is not literal. */
export function literalWords(line: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (const char of line) {
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (DOUBLE_SPECIAL.has(char)) return null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    if (UNQUOTED_SPECIAL.has(char)) return null;
    word += char;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(word);
  return words;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "/bin/sh", "/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/dash"]);

/** The words of the request: a shell line, or an argv — `sh -c '<line>'` read as its line. Null: not a command. */
function wordsOf(raw: Record<string, unknown>): string[] | null {
  const command = raw.command ?? raw.cmd;
  if (typeof command === "string") return literalWords(command.trim());
  if (Array.isArray(command) && command.length > 0 && command.every((part): part is string => typeof part === "string")) {
    if (command.length === 3 && SHELLS.has(command[0]!) && (command[1] === "-c" || command[1] === "-lc")) return literalWords(command[2]!.trim());
    return command;
  }
  return null;
}

const RM = new Set(["rm", "/bin/rm", "/usr/bin/rm"]);
const RM_SHORT = new Set(["r", "R", "f", "i", "v", "d"]);
const RM_LONG = new Set(["--recursive", "--force", "--verbose", "--dir"]);

/** The targets of a delete command, `null` for one this file does not know, or a refusal for a known one it doubts. */
function targetsOf(words: readonly string[]): { command: string; targets: string[] } | { why: string } | null {
  const [head, ...rest] = words;
  if (!head) return null;
  if (RM.has(head)) {
    const targets: string[] = [];
    let options = true;
    for (const word of rest) {
      if (options && word === "--") {
        options = false;
        continue;
      }
      if (options && word.startsWith("--")) {
        if (!RM_LONG.has(word)) return { why: `rm's option ${word} is not one this rule knows` };
        continue;
      }
      if (options && word.startsWith("-") && word.length > 1) {
        if (![...word.slice(1)].every((flag) => RM_SHORT.has(flag))) return { why: `rm's option ${word} is not one this rule knows` };
        continue;
      }
      targets.push(word);
    }
    return { command: "rm", targets };
  }
  if (head === "rmdir" || head === "unlink") {
    const targets = rest.filter((word) => word !== "-v" && word !== "--verbose");
    if (targets.some((word) => word.startsWith("-"))) return { why: `${head} with an option this rule does not know` };
    if (head === "unlink" && targets.length !== 1) return { why: "unlink takes one file" };
    return { command: head, targets };
  }
  if (head === "git" && rest[0] === "worktree" && rest[1] === "remove") {
    const args = rest.slice(2);
    const targets = args.filter((word) => word !== "-f" && word !== "--force");
    if (targets.length !== 1 || targets[0]!.startsWith("-")) return { why: "git worktree remove takes one worktree and only --force" };
    return { command: "git worktree remove", targets };
  }
  return null;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !escapes(rel);
}

/** Whether `rawInput` is a delete that stays inside `scope` — and, when it is not, why it goes to a person. */
export function insideDelete(request: DeleteRequest, scope: DeleteScope): DeleteVerdict {
  const raw = request.rawInput;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return no("the request carries no command");
  const input = raw as Record<string, unknown>;
  let parsed: { command: string; targets: string[] } | { why: string } | null;
  // A CLI's own file delete (ACP kind "delete") names its path rather than a command.
  const path = input.path ?? input.file_path;
  if (request.kind === "delete" && typeof path === "string") parsed = { command: "delete", targets: [path] };
  else {
    const words = wordsOf(input);
    if (words === null) return no("the command is not literal words: a chain, a variable, a glob, a subshell or a quote this rule does not read");
    parsed = targetsOf(words);
  }
  if (parsed === null) return no("not a delete");
  if ("why" in parsed) return no(parsed.why);
  if (parsed.targets.length === 0) return no("a delete with no target");

  const real = scope.real ?? realPathStrict;
  // Only a folder the request itself names: the shell's own may have moved since the session opened.
  const cwd = typeof input.cwd === "string" && isAbsolute(input.cwd) ? input.cwd : null;
  const roots = scope.roots.map((root) => resolve(root));
  const realRoots = roots.map((root) => real(root)).filter((root): root is string => root !== null);
  const kept = scope.keep.flatMap((one) => [resolve(one), real(one)]).filter((one): one is string => one !== null);
  if (realRoots.length === 0) return no("the mission's folder does not exist");

  const targets: string[] = [];
  for (const target of parsed.targets) {
    if (target === "") return no("an empty target");
    if (!isAbsolute(target) && cwd === null) return no(`${target} is a relative path, and the folder the CLI's shell is in is not known`);
    const written = cwd === null ? resolve(target) : resolve(cwd, target);
    if (!roots.some((root) => within(root, written))) return no(`${target} is outside the mission's folder`);
    // Exists: its real path, every symlink on the way followed. Does not: its parent's, which must exist. Looked up as
    // written, not as `written`: the kernel follows a link before it reads the `..` after it, so `escape/../x`, with
    // `escape` a link out, is `x` beside the link's target — collapsed as text first, it read as inside and was allowed.
    const raw = isAbsolute(target) ? target : `${cwd!}/${target}`;
    const leaf = real(raw);
    const parent = leaf === null ? real(dirname(raw)) : null;
    if (leaf === null && parent === null) return no(`${target} and its folder do not exist`);
    const resolved = leaf ?? join(parent!, basename(raw));
    if (!realRoots.some((root) => within(root, resolved))) return no(`${target} resolves outside the mission's folder (${resolved})`);
    if (kept.includes(written) || kept.includes(resolved)) return no(`${target} is the mission's own folder or worktree`);
    targets.push(resolved);
  }
  return { inside: true, command: parsed.command, targets };
}

/** A mission's scope: its own folder, where its worktree and its helpers' are; neither the folder nor its worktree goes. */
export function missionDeleteScope(own: string, workdir: string | undefined): DeleteScope {
  return { roots: [own], keep: [own, ...(workdir ? [workdir] : [])] };
}
