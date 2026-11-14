/**
 * A file the daemon writes into an agent's folders, written as that agent (the isolation RFC's §3): one owner for each
 * file there, so the agent's own command can `chmod +x` a script `write` made, and `ssh` reads a config its user owns.
 * Through the helper's `put`, whole or not at all; where agents' commands run as the daemon's user, as the daemon,
 * the same way.
 *
 * And what an admin deletes there, deleted as that agent (`removeAsAgent`): what an agent's command made is its
 * user's, in folders the daemon's user often cannot change.
 */

import { NourideError } from "@nouride/shared";
import { removePath, writeFileAtomic, writeTextFileAtomic } from "./fs.ts";
import { runCommand } from "./process.ts";
import { agentCommandsHaveOwnUsers, putAsAgent } from "./process-agents.ts";

/** Long enough for any file a tool writes; a write that takes longer is one that is stuck. */
const PUT_TIMEOUT_MS = 60_000;

export async function writeFileAsAgent(agent: string, path: string, data: string | Uint8Array): Promise<void> {
  const line = putAsAgent(agent, path);
  if (!line) {
    await (typeof data === "string" ? writeTextFileAtomic(path, data) : writeFileAtomic(path, data));
    return;
  }
  const out = await runCommand(line, { cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeoutMs: PUT_TIMEOUT_MS, maxOutputBytes: 4096, stdin: data });
  if (out.exitCode !== 0) {
    const why = out.stderr.trim() || (out.timedOut ? "it took too long" : `exit ${out.exitCode}`);
    throw new NourideError("write_as_agent", `${path} could not be written as ${agent}: ${why}`, "A file could not be written.");
  }
}

/** A folder of many thousands of files is gone well inside this; one that is not is stuck. */
const REMOVE_TIMEOUT_MS = 120_000;

/**
 * `path` and everything in it, deleted as `agent`: by `rm` run as that agent's user, which removes what that user
 * may and leaves the rest, a link deleted as the link and never followed. Where agents' commands run as the daemon's
 * user, the daemon deletes it itself. Whether it is gone is the caller's to look at: part of it may be another's.
 */
export async function removeAsAgent(agent: string, path: string): Promise<void> {
  if (!agentCommandsHaveOwnUsers()) {
    removePath(path);
    return;
  }
  await runCommand(["rm", "-rf", "--", path], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeoutMs: REMOVE_TIMEOUT_MS, maxOutputBytes: 4096, agent });
}
