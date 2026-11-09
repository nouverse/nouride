/**
 * What is already installed for an agent with a shell, and where its programs keep their settings.
 *
 * Two questions agents answered by probing. The bin directory was never listed, so the live box saw
 * 107 `which` calls (a third of them failing) and 59 calls by full path into it — for programs that
 * were on PATH all along. And nothing said HOME persists and is shared, so a CLI got logged in again,
 * or configured inside a project where the next clone loses it.
 *
 * Two halves, in two places, because they change at different rates. The rule — what is in the
 * bin directory is on PATH, call it by name, HOME is where settings live — is the harness's and never
 * moves. What the directory holds is read from it each time (one `stat` while it is unchanged), so an
 * install shows up on the next request and a removal disappears — the prompt can never claim a program
 * that is not there. That listing used to sit in the harness too, so an agent installing something
 * mid-conversation rewrote a cached block and took the harness out of the cache; it is in RUNTIME now,
 * the last block, which a new day moves anyway.
 */

import { dirname, join } from "@nouride/runtime";
import { agentsOwnHome, installedTools } from "@/modules/toolchain/facts.ts";

/** Past this the line stops being something a model reads; `ls` is one call away. */
const MAX_LISTED = 40;

/** The harness's half: what the bin directory is for, and HOME. Nothing here moves when a program is installed. */
export function toolchainLines(binDir: string | undefined, own?: { home?: string; sharedBin?: string }): string[] {
  if (!binDir) return [];
  // Its own user (0.8.0): what it installs is its own, the shared directory is to run, and HOME is nobody else's.
  if (own?.home) {
    return [
      `- What you install lands in \`${binDir}\`, first on PATH for your commands, so call it by name, with no \`which\` and no full path.` +
        (own.sharedBin ? ` What is installed for every agent is in \`${own.sharedBin}\`, on PATH behind it: yours to run, the operator's to change.` : "") +
        " RUNTIME lists what is there now.",
      `- $HOME is \`${own.home}\`, your own folder: it persists across restarts and updates and no other agent reads it. Programs keep their settings and logins there, so set a tool up once in its own config under HOME, never inside a project.`,
    ];
  }
  const lines = [
    `- What is installed in \`${binDir}\` is on PATH for every command, so call it by name, with no \`which\` and no full path. RUNTIME lists what is there now.`,
  ];
  const home = agentsOwnHome(join(dirname(binDir), "data"));
  if (home) {
    lines.push(
      `- $HOME is \`${home}\`. It persists across restarts and updates and every agent here shares it: programs keep their settings and logins there, so set a tool up once in its own config under HOME, never inside a project.`,
    );
  }
  return lines;
}

/** RUNTIME's half: what the bin directories hold right now — the agent's own, then the shared one — or nothing. */
export function installedLine(binDir: string | undefined, sharedBin?: string): string | undefined {
  const parts = [binDir, sharedBin].filter((dir): dir is string => dir !== undefined).flatMap((dir) => {
    const tools = installedTools(dir);
    if (tools.length === 0) return [];
    // `$NOURIDE_BIN` is the first one, the agent's own where it is its own user.
    const more = tools.length > MAX_LISTED ? `, and ${tools.length - MAX_LISTED} more (\`ls ${dir === binDir ? "$NOURIDE_BIN" : dir}\`)` : "";
    return [`Installed in \`${dir}\`, on PATH: ${tools.slice(0, MAX_LISTED).join(", ")}${more}.`];
  });
  return parts.length > 0 ? parts.join(" ") : undefined;
}
