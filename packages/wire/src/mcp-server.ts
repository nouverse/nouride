/**
 * Nouride as an MCP server (`routes/mcp-server.ts`): switched on and off, and its tokens.
 */

/** What a token may do: read memory, save conversations to it, read personas. */
export type McpScope = "memory" | "memory:write" | "personas";

export interface McpTokenView {
  id: string;
  /** The `[[people]]` key it belongs to. */
  person: string;
  agents: string[];
  scopes: McpScope[];
  /** The client it was made for — `claude_code`, `zed`. */
  label: string;
  lastUsedAt: number | null;
  /** When it stops working — null never does, absent from a daemon before 0.7.9. */
  expiresAt?: number | null;
}
