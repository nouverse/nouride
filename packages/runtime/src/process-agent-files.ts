/**
 * A file the daemon writes into an agent's folders, written as that agent (the isolation RFC's §3): one owner for each
 * file there, so the agent's own command can `chmod +x` a script `write` made, and `ssh` reads a config its user owns.
 * Through the helper's `put`, whole or not at all; where agents' commands run as the daemon's user, as the daemon,
 * the same way.
 */

import { NourideError } from "@nouride/shared";
import { writeFileAtomic, writeTextFileAtomic } from "./fs.ts";
import { runCommand } from "./process.ts";
import { putAsAgent } from "./process-agents.ts";

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
