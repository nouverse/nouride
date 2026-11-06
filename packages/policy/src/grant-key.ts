import { createHash } from "@nouride/runtime";
/**
 * The identity a durable grant is bound to.
 *
 * This is the load-bearing part of `allow-always`. A grant keyed on something too loose turns
 * one human "yes" into a standing permission for commands the human never saw. Openclaw binds
 * argv, cwd, agent, session and env keys, and hashes the contents of a file operand the command
 * will execute; we bind the same things minus session (a grant that dies when the chat rotates
 * is not durable in any useful sense).
 *
 * `node:crypto` rather than the runtime adapter on purpose: this package must be usable without
 * a daemon — that is what makes the decision layer testable — and `createHash` is portable, not
 * a Bun API, so TD-001 has nothing to say about it.
 */


/**
 * Bumped when the digest input changes.
 *
 * Openclaw's source carries a warning that changing the digest input *silently orphans* every
 * persisted grant. A version in the key makes that visible instead: old keys stop matching,
 * `nouride grants list` still shows them with their version, and the operator is told to
 * re-grant rather than quietly being asked again with no explanation.
 */
export const GRANT_KEY_VERSION = "g1";

/**
 * Length-prefixed so no two different inputs can produce the same digest input.
 *
 * Joining on a separator is not enough: `["a", "b"]` and `["a b"]` would hash identically under
 * a space join, which is exactly the ambiguity an attacker-controlled argv would aim for.
 */
function canonical(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("");
}

export interface GrantKeyInput {
  agentId: string;
  /** Resolved absolute path. The same argv in a different directory is a different command. */
  cwd: string;
  argv: readonly string[];
  /**
   * sha256 of the file this command executes, when it executes one.
   *
   * `bash deploy.sh` granted once must not stay granted after `deploy.sh` is rewritten — that
   * is a permanent grant for arbitrary code. With the digest bound in, editing the script
   * invalidates the grant and the next run asks again.
   */
  fileSha256?: string | undefined;
  /**
   * The secrets this command receives (S6). A grant for a command is not a grant for the credentials it is handed:
   * binding another secret to it asks again. Absent from the key when there are none, so every grant made before
   * still matches.
   */
  secrets?: readonly string[] | undefined;
}

export interface ToolGrantKeyInput {
  agentId: string;
  /** The tool name. `write` granted in a directory says nothing about `exec` in it. */
  tool: string;
  /** Resolved absolute directory the grant is confined to. */
  scopeDir: string;
}

/**
 * The identity of a durable grant for a non-`exec` tool.
 *
 * Bound to a directory, which is the whole reason this can be offered. `exec` binds argv and a script
 * digest because a command *is* its arguments; a `write` has no equivalent identity, so an unbounded
 * "always allow write" would be a standing permission for content nobody has seen. Scoping it to a
 * directory the sandbox already confines the agent to makes the grant no broader than the sandbox.
 *
 * Shares `GRANT_KEY_VERSION` with exec grants: both are invalidated together when the digest input
 * changes, which is the honest outcome — a half-migrated grant table is worse than one that asks again.
 */
export function toolGrantKey(input: ToolGrantKeyInput): string {
  return createHash("sha256")
    .update(canonical([GRANT_KEY_VERSION, "tool", input.agentId, input.tool, input.scopeDir]))
    .digest("hex");
}

export function execGrantKey(input: GrantKeyInput): string {
  const digest = createHash("sha256")
    .update(
      canonical([
        GRANT_KEY_VERSION,
        input.agentId,
        input.cwd,
        ...input.argv,
        input.fileSha256 ?? "",
        ...(input.secrets?.length ? ["secrets", ...[...input.secrets].sort()] : []),
      ]),
    )
    .digest("hex");
  return `${GRANT_KEY_VERSION}:${digest.slice(0, 32)}`;
}

/** Programs whose file argument is executed rather than merely read. */
const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "ruby",
  "perl",
  "php",
  "Rscript",
  "osascript",
]);

/**
 * The argv index of a file this command will execute, or `null`.
 *
 * Callers hash that file and pass the digest as `fileSha256`. Kept here, next to the key, so
 * the two halves of the rule cannot drift apart.
 *
 * First non-flag argument only. `python3 -u script.py` is the shape that matters; resolving
 * every interpreter's full flag grammar is not something this can be right about, and a wrong
 * *guess* here fails safe — a missed file operand means the grant covers less than it could,
 * never more.
 */
export function executedFileArgIndex(argv: readonly string[]): number | null {
  const program = (argv[0] ?? "").replace(/\\/g, "/");
  const base = program.slice(program.lastIndexOf("/") + 1);
  if (!INTERPRETERS.has(base)) return null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg.startsWith("-")) continue;
    // `python3 -c "print(1)"` executes no file: the code is inline, and there is nothing whose
    // change should revoke a grant. Same for `node -e`.
    if ((argv[i - 1] ?? "").match(/^-{1,2}(c|e|eval|command)$/)) return null;
    return i;
  }
  return null;
}
