/**
 * Where the workspace's folders are, as a files view's paths: the two the Workspace tab goes into, and one agent's own.
 */

/** The workspace's two folders: each agent's own under `private`, and the one every agent shares. */
export const WORKSPACE_FOLDERS = ["private", "shared"] as const;

/** An agent's own folder under the workspace at `workspace`. */
export function agentFolder(workspace: string, agentId: string): string {
  return `${workspace}/private/${agentId}`;
}
