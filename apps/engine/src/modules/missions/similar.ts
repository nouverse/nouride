/**
 * *Approve similar from this mission* (0.8.7): a person's yes to one command that also covers the commands like it, for
 * that mission only, until it ends. A mission running `bun test` twenty times asked twenty times; the person answered
 * twenty buttons for one decision.
 *
 * "Like it" is the tool and the command's first words — `git push`, `bun test`, `rm` — read as literal words
 * (`inside-delete.ts` `literalWords`): a command with a chain, a variable or a subshell has no kind, is never offered the
 * button, and is never covered by one. Kept in memory: a restart forgets it, and the next such command is asked again —
 * the safe way to lose it. No table, no migration.
 */

import { basename } from "@nouride/runtime";
import { literalWords } from "@/modules/external-agents/inside-delete.ts";

/** Programs whose second word names what they do — `git push` is not `git status`. */
const WITH_SUBCOMMAND = new Set(["git", "bun", "npm", "pnpm", "yarn", "npx", "bunx", "cargo", "go", "docker", "kubectl", "make", "uv", "pip", "gh", "systemctl"]);
/** Programs that run the code they are given: their second word is the script, and `-c`/`-e` code has no kind. */
const RUNS_CODE = new Set(["sh", "bash", "zsh", "dash", "python", "python3", "node", "deno", "perl", "ruby"]);

/**
 * The kind of a call — `<tool> <program> [<subcommand or script>]` — or null where it has none. A program that takes a
 * subcommand or runs a script has a kind only when one follows its name: a flag first (`git -C … push`, `bash -c …`,
 * `node -e …`) decides what it does by more than its name, and `bash ./test.sh` approved as similar must not cover
 * `bash -c "<anything>"`.
 */
export function similarKind(tool: string, params: Record<string, unknown>): string | null {
  const command = params.command;
  const words = typeof command === "string" ? literalWords(command.trim()) : Array.isArray(command) && command.every((part) => typeof part === "string") ? (command as string[]) : null;
  if (!words || words.length === 0) return null;
  const program = basename(words[0]!);
  if (!program || program.includes("=") || program === "sudo" || program === "env") return null;
  if (!WITH_SUBCOMMAND.has(program) && !RUNS_CODE.has(program)) return `${tool} ${program}`;
  const sub = words[1];
  return sub && !sub.startsWith("-") ? `${tool} ${program} ${sub}` : null;
}

/** The kind as a person reads it on the prompt: the command's part, without the tool. */
export function similarLabel(kind: string): string {
  return kind.slice(kind.indexOf(" ") + 1);
}

export class SimilarAllowed {
  private readonly kinds = new Map<string, Set<string>>();

  allow(missionId: string, kind: string): void {
    const kinds = this.kinds.get(missionId) ?? new Set<string>();
    kinds.add(kind);
    this.kinds.set(missionId, kinds);
  }

  allows(missionId: string, tool: string, params: Record<string, unknown>): boolean {
    const kind = similarKind(tool, params);
    return kind !== null && this.kinds.get(missionId)?.has(kind) === true;
  }

  /** The mission ended: what was allowed for it goes with it. */
  forget(missionId: string): void {
    this.kinds.delete(missionId);
  }

  get size(): number {
    return this.kinds.size;
  }
}
