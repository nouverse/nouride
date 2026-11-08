/**
 * Each agent's switches and credentials for the library's MCP servers, and their tools (`routes/mcp.ts`).
 */

/** Whose login a Connect or Log out means: the library's, or the one this agent's server uses. */
export type McpLoginScope = { agentId: string } | { library: true };

/** An agent's credential for a library server: the library's, or its own — a token, variables, or a login. */
export type AgentMcpCredential = "library" | { token?: string; envSecrets?: Record<string, { value?: string }>; login?: boolean };

/** One of a server's tools for one agent (0.7.21): what it adds to every request, and whether the agent has it. */
export interface AgentMcpTool {
  /** The server's own name for it. */
  name: string;
  description: string;
  /** Bytes of schema it adds to every request while on; absent for a name no provider takes. */
  bytes?: number;
  on: boolean;
}
