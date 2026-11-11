/**
 * Nouride as an MCP server (`/mcp`): switched on and off, and its tokens. Split out of `api.ts`, and
 * spread into `api` like the others. The payload types are `@nouride/wire`'s.
 */

import { control, post, request } from "./api.client";
import type { McpScope, McpTokenView } from "@nouride/wire";

export const mcpServerApi = {
  mcpServer: () => request<{ enabled: boolean; tokens: McpTokenView[] }>(`${control}/mcp-server`),
  setMcpServerEnabled: (enabled: boolean) =>
    request<{ enabled: boolean }>(`${control}/mcp-server`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }),
  createMcpToken: (input: { person: string; agents: string[]; label: string; scopes: McpScope[] }) =>
    post<{ token: McpTokenView; value: string; enabled: boolean }>(`${control}/mcp-server/tokens`, input),
  revokeMcpToken: (id: string) => request<{ id: string; revoked: boolean }>(`${control}/mcp-server/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
