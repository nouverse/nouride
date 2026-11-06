/**
 * The layout of `data/workspace/`, in one place.
 *
 * Three directories, and the distinction between them is the whole point:
 *
 * - `shared/` — every agent can reach it. The default working directory, because handover is the
 *   normal case in a multi-agent install.
 * - `private/<id>/` — one agent can reach it. Drafts, and work nobody else should pick up.
 * - `private/<id>/.scratchpad/` — one agent, and **disposable**. Artefacts that exist for a turn or
 *   two: a screenshot about to be sent, a download on its way to being converted.
 *
 * The scratchpad is not just a naming convention. `@nouride/policy` treats a delete inside a
 * `.scratchpad` as ordinary rather than hardline (see `SCRATCHPAD_DIRNAME`), so it is the one place
 * an agent can clear up after itself without a `destructive` prompt that the `balanced` approval level is not
 * allowed to answer. That only works if the agent actually puts throwaway work there, which is what the harness
 * section of the prompt tells it.
 *
 * Nested *inside* `private/` rather than being a fourth top-level directory: it is already covered by
 * the workspace root the agent has, so `read`, `write` and `send_file` reach it with no new sandbox
 * entry — and a scratchpad another agent could read would not be scratch, it would be handover.
 *
 * The functions live here rather than on the pipeline because three callers need the same paths — the
 * pipeline creates them, the prompt names them, and the retention sweep walks them — and three
 * derivations of one layout is how a directory ends up created in one place and swept in another.
 */

import { join, listDir, removePath, runCommand, statFile } from "@nouride/runtime";
import { SCRATCHPAD_DIRNAME } from "@nouride/policy";
import { createLogger } from "@nouride/shared";

const log = createLogger("workspace");

/** Reachable by every agent. Where handover happens, and the default cwd. */
export function sharedWorkspace(workspaceDir: string): string {
  return join(workspaceDir, "shared");
}

/**
 * One agent's own directory.
 *
 * A sibling of `shared/`, not a child: nested, an agent listing the shared directory would see every
 * other agent's private folder sitting inside it.
 */
export function privateWorkspace(workspaceDir: string, agentId: string): string {
  return join(workspaceDir, "private", agentId);
}

/** The disposable corner of an agent's private directory. */
export function scratchpadFor(privateDir: string): string {
  return join(privateDir, SCRATCHPAD_DIRNAME);
}

/**
 * Delete scratchpad entries older than `days`, across every agent. Returns how many went.
 *
 * A sweep rather than a delete at the end of the turn, and that is the part worth being explicit
 * about: the obvious design is to remove the screenshot once it has been sent, and it is wrong. The
 * next message is often *about* the file — "kirim ulang yang tadi", "crop bagian atasnya" — and an
 * agent that binned it a second after sending has to do the work again, if it still can. Keeping it
 * for a few days costs a few megabytes and answers the follow-up.
 *
 * Per entry by mtime, not per directory as the tool-output spill does: a scratchpad's files are
 * unrelated to each other, so a fresh one is no reason to keep a stale one. `0` disables the sweep
 * rather than deleting everything — the same off position every other retention knob uses.
 *
 * Removed as the agent whose scratchpad it is (`SandboxOptions.agent`): where each agent runs as its own user (0.8.0)
 * the scratchpad and everything in it are that user's, and the daemon may not remove them — the sweep failed on every
 * entry, live, and a scratchpad kept growing. Elsewhere that runs as the daemon, as it always did; and a folder whose
 * agent has no user any more (one deleted) is the daemon's own, so what the agent could not remove the daemon tries.
 *
 * Failures are logged and skipped. This runs on a boot-and-daily timer, and a file that cannot be
 * removed — a permission, a mount that went away — must not take the rest of the sweep with it.
 */
export async function sweepScratchpads(workspaceDir: string, days: number, now: number = Date.now()): Promise<number> {
  if (days <= 0) return 0;
  const cutoff = now - days * 24 * 60 * 60_000;
  let removed = 0;

  for (const agent of listDir(join(workspaceDir, "private"))) {
    if (!agent.isDirectory) continue;
    const scratchpad = scratchpadFor(privateWorkspace(workspaceDir, agent.name));
    const stale = listDir(scratchpad)
      .map((entry) => join(scratchpad, entry.name))
      .filter((path) => {
        const stat = statFile(path);
        return stat !== null && stat.mtimeMs < cutoff;
      });
    if (stale.length === 0) continue;
    await runCommand(["rm", "-rf", "--", ...stale], {
      cwd: scratchpad,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 120_000,
      maxOutputBytes: 8192,
      agent: agent.name,
    }).catch(() => null);
    for (const path of stale) {
      if (statFile(path) === null) {
        removed += 1;
        continue;
      }
      try {
        removePath(path);
        removed += 1;
      } catch (err) {
        log.warn("could not remove a stale scratchpad entry", { path, error: String(err) });
      }
    }
  }

  return removed;
}
