/**
 * The files an agent's persona is made of (0.8.8): who it is, its rules and its boundaries. They change only through the
 * `persona` tool, which asks an admin; the file tools refuse them to the agent itself (`builtins/files.ts`).
 */

import { basename, dirname, join, realPath } from "@nouride/runtime";

export const PERSONA_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md"] as const;
export type PersonaFile = (typeof PERSONA_FILES)[number];

/**
 * Whether `path` — resolved, as the file tools resolve it — is one of the agent's own persona files, in its pack.
 *
 * The pack is a root for `MEMORY.md`, and that let `write` and `edit` rewrite the files that hold the agent's
 * confirmation rules and boundaries with no prompt. By name whatever its case: on a case-insensitive disk the name in
 * lower case is the same file. `MEMORY.md` stays the agent's.
 */
export function isOwnPersona(agentDir: string, path: string): boolean {
  const name = basename(path).toLowerCase();
  if (dirname(path) === realPath(agentDir) && PERSONA_FILES.some((file) => file.toLowerCase() === name)) return true;
  // And where the pack's file is a link — a persona an operator keeps in a shared folder — the file it leads to (Nox's
  // review, 0.8.8): written there, it was written to the pack.
  return PERSONA_FILES.some((file) => realPath(join(agentDir, file)) === path);
}

export const OWN_PERSONA_REFUSAL =
  "That is your persona (who you are, your rules and your boundaries), and it changes only with an admin's yes. Propose the " +
  "change with the `persona` tool: the whole file, or one section, and why.";
