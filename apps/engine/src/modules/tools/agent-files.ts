/**
 * A file a tool writes for an agent, written as that agent where it is one of its own folders (`ToolContext.ownFolders`)
 * and each agent's commands run as its own user — so the file has one owner, the one whose commands use it: a script
 * `write` made is one its own command can `chmod +x`, and `ssh` reads a `~/.ssh/config` its user owns (the isolation
 * RFC's §3). As the daemon everywhere else it may write — the pack, the conversation's attachments — and everywhere when
 * the agents share the daemon's user, as before.
 */

import { agentCommandsHaveOwnUsers, realPath, writeFileAsAgent, writeFileAtomic, writeTextFileAtomic } from "@nouride/runtime";
import type { ToolContext } from "@nouride/shared";

/**
 * Both as real paths: the file tools hand over the one `resolveWithin` found, links followed, and a folder named through
 * a link — a declared root, a workspace on a linked disk — matched none of them, so the file was saved as the daemon's.
 */
function isOwn(ctx: Pick<ToolContext, "ownFolders">, path: string): boolean {
  const at = realPath(path);
  return (ctx.ownFolders ?? []).map(realPath).some((folder) => at === folder || at.startsWith(`${folder}/`));
}

export async function writeAgentFile(ctx: Pick<ToolContext, "agentId" | "ownFolders">, path: string, content: string | Uint8Array): Promise<void> {
  if (agentCommandsHaveOwnUsers() && isOwn(ctx, path)) return writeFileAsAgent(ctx.agentId, path, content);
  await (typeof content === "string" ? writeTextFileAtomic(path, content) : writeFileAtomic(path, content));
}
