/**
 * The install's MCP servers (0.7.19): the library — Configure → MCP — and each agent's switches and credentials for
 * it, on the agent's MCP tab. A login is the library's, used by every agent with none of its own, or one
 * agent's. Never a secret or its name comes back — only whether one is set.
 */

import { control, post, request } from "./api.client";
import type { AgentMcpCredential, AgentMcpTool, McpLibraryServer, McpLoginScope, McpServerInput } from "@nouride/wire";

export const mcpLibraryApi = {
  mcpLibrary: () => request<{ servers: McpLibraryServer[]; error?: string }>(`${control}/mcp/library`),

  /** Into the library — and switched on for `enable`, the agents picked while adding it. */
  saveLibraryServer: (input: McpServerInput & { perAgent?: boolean; enable?: string[] }) =>
    post<{ ok: true; restartRequired: boolean }>(`${control}/mcp/library`, input),

  /** Out of the library and every agent; its logins go with it. */
  deleteLibraryServer: (name: string) => request<{ ok: true; restartRequired: boolean }>(`${control}/mcp/library/${encodeURIComponent(name)}`, { method: "DELETE" }),

  /** On or off for one agent, or the credential it uses there. */
  setAgentMcp: (agent: string, name: string, change: { on?: boolean; credential?: AgentMcpCredential; tools?: string[] | null }) =>
    request<{ ok: true; restartRequired: boolean }>(`${control}/agents/${encodeURIComponent(agent)}/mcp/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(change),
    }),

  /** Every tool the server offers this agent (0.7.21) — 409 while it is not connected for it. `all`: no list chooses. */
  agentMcpTools: (agent: string, name: string) =>
    request<{ tools: AgentMcpTool[]; all: boolean; unknown?: string[] }>(`${control}/agents/${encodeURIComponent(agent)}/mcp/${encodeURIComponent(name)}/tools`),

  /**
   * A remote server's login started: the address of its authorization server's page, to open in a new tab. A client
   * registered by hand goes with it for a server that registers none. Discovery and registration are network round
   * trips to somebody else's server, so the wait is longer than a route here takes.
   */
  // Each path written out, rather than built from the scope, so the route contract can read it.
  startMcpLogin: (scope: McpLoginScope, server: string, client?: { clientId: string; clientSecret?: string }) =>
    "library" in scope
      ? post<{ url: string }>(`${control}/mcp/library/${encodeURIComponent(server)}/oauth/start`, client ?? {}, { timeoutMs: 45_000 })
      : post<{ url: string }>(`${control}/agents/${encodeURIComponent(scope.agentId)}/mcp/${encodeURIComponent(server)}/oauth/start`, client ?? {}, { timeoutMs: 45_000 }),

  /** The login finished: the code and state the browser came back with, or the whole address it landed on. */
  finishMcpLogin: (answer: { code: string; state: string } | { url: string }) =>
    post<{ ok: true; holder: string; server: string; scope?: string }>(`${control}/mcp/oauth/finish`, answer, { timeoutMs: 45_000 }),

  /** Its tokens deleted; the servers using it wait for a login again. */
  logoutMcpServer: (scope: McpLoginScope, server: string) =>
    "library" in scope
      ? request<{ ok: true }>(`${control}/mcp/library/${encodeURIComponent(server)}/oauth`, { method: "DELETE" })
      : request<{ ok: true }>(`${control}/agents/${encodeURIComponent(scope.agentId)}/mcp/${encodeURIComponent(server)}/oauth`, { method: "DELETE" }),
};
