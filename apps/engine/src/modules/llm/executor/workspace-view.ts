/**
 * Where a turn's files are, told once and to everyone.
 *
 * The prompt says a relative path resolves to the shared workspace; the tool sandbox has to agree,
 * or the agent is told to write somewhere `write` will refuse. Two derivations of the same fact is
 * what allowed that to happen, so there is one.
 */

import { readTextFileSync } from "@nouride/runtime";
import type { TurnRequest } from "./types.ts";

/**
 * Lines in a file, without reading a large one into memory to count them.
 *
 * A preview says "replaces 400 lines"; that number is worth a read of a source file and not worth a read
 * of a 200MB log. Above the cap it returns -1, which renderers show as a byte count alone rather than
 * inventing a line count — the rule against made-up numbers applies to cosmetics too.
 */
const MAX_LINE_COUNT_BYTES = 2 * 1024 * 1024;

export function countFileLines(path: string, size: number): number {
  if (size > MAX_LINE_COUNT_BYTES) return -1;
  try {
    const text = readTextFileSync(path);
    if (text === "") return 0;
    const bare = text.endsWith("\n") ? text.slice(0, -1) : text;
    return bare.split("\n").length;
  } catch {
    return -1;
  }
}


/**
 * Where work happens, and every directory the tools will accept a path in.
 *
 * Computed once and used by both the prompt and the `ToolContext`. They were derived separately and
 * drifted apart: the context resolved relative paths against the derived workspace, while the
 * harness block told the agent it was working in `agent.dir` — its persona pack. A model that
 * followed its instructions therefore built the operator's project inside the git-tracked directory
 * holding `IDENTITY.md` and `MEMORY.md`, which is the exact outcome deriving a workspace was meant
 * to prevent. Observed on a real run: `agents/nouva/portfolio/` existed and `data/workspace/` was
 * empty.
 *
 * Two derivations of the same fact is what allowed that, so there is now one.
 */
export function workspaceView(req: TurnRequest): {
  dir: string;
  privateDir?: string;
  roots: string[];
  /** Of those, the agent's own: everything but its pack and the attachments (`ToolContext.ownFolders`). */
  own: string[];
} {
  const { agent } = req;
  return {
    dir: req.workspaceDir ?? agent.dir,
    privateDir: req.privateDir,
    // Widest first, and every one of them reachable:
    //   - the shared workspace, so ordinary work needs no path at all
    //   - this agent's private directory, for work it should keep to itself
    //   - the pack, so the agent can read its own IDENTITY and write MEMORY.md
    //   - declared roots, which are purely opt-in: an existing project to work on
    //   - this turn's attachments, so a file the sender just posted can be opened
    //
    // The shared directory is what makes handover possible at all. With a workspace per agent,
    // `@nox benerin build ini` named a path outside every root Nox had, so the sandbox refused it
    // however it was spelled — the mention feature could pass an instruction but never the work.
    //
    // Another agent's *private* directory is deliberately absent, which is the whole distinction:
    // one place both can reach, one place only the owner can.
    //
    // The attachment root has to be in here or the prompt would name a path the sandbox then
    // refuses — the agent would know the file exists and be unable to open it.
    roots: [
      ...(req.workspaceDir ? [req.workspaceDir] : []),
      ...(req.privateDir ? [req.privateDir] : []),
      agent.dir,
      ...agent.config.workspaceRoots,
      ...(req.attachmentRoot ? [req.attachmentRoot] : []),
    ],
    own: [...(req.workspaceDir ? [req.workspaceDir] : []), ...(req.privateDir ? [req.privateDir] : []), ...agent.config.workspaceRoots],
  };
}
