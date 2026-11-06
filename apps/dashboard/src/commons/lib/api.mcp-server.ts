/**
 * Nouride as an MCP server (`/mcp`): switched on and off, and its tokens. Split out of `api.ts`, and
 * spread into `api` like the others. The types are the engine's, duplicated rather than imported: the
 * dashboard is its own build.
 */

import { control, post, request } from "./api.client";

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

export const mcpServerApi = {
  mcpServer: () => request<{ enabled: boolean; tokens: McpTokenView[] }>(`${control}/mcp-server`),
  setMcpServerEnabled: (enabled: boolean) =>
    request<{ enabled: boolean }>(`${control}/mcp-server`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }),
  createMcpToken: (input: { person: string; agents: string[]; label: string; scopes: McpScope[] }) =>
    post<{ token: McpTokenView; value: string; enabled: boolean }>(`${control}/mcp-server/tokens`, input),
  revokeMcpToken: (id: string) => request<{ revoked: boolean }>(`${control}/mcp-server/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
