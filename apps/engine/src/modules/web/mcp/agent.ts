/**
 * `POST /mcp/agent` — Nouride's tools for an external agent's CLI, during its turn (0.8.1). The
 * protocol is `/mcp`'s (`serveRpc`); what is offered and how a call runs is `external-agents/lent-tools.ts`'s.
 *
 * Its own path and its own bearer — `nagt_…`, handed to the CLI when its session opens, one conversation's, or the
 * agent's own in the CLI's environment with the conversation named beside it (`lent-tools.ts`) — never a
 * client token of `/mcp`'s, and on whether `[mcp_server]` is on it does not depend: the CLI runs on this box, as the
 * agent, and this is the agent's own toolbox reached the CLI's way. Loopback only, for the same reason.
 */

import type { Hono } from "hono";
import { createLogger } from "@nouride/shared";
import { negotiateVersion } from "@nouride/mcp";
import { CONVERSATION_HEADER, type LentTools, type Session } from "@/modules/external-agents/lent-tools.ts";
import { fail, ok, serveRpc, type Message, type Reply } from "./index.ts";

const log = createLogger("web.mcp.agent");

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

export interface AgentMcpDeps {
  lent: Pick<LentTools, "resolve" | "definitions" | "call">;
  version: string;
}

async function answer(deps: AgentMcpDeps, session: Session, message: Message): Promise<Reply | null> {
  const { id, method } = message;
  const params = message.params ?? {};
  if (id === undefined || id === null) return null;
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: "nouride", version: deps.version },
        instructions: "Nouride's tools for this agent: other agents, what the household remembers, this conversation's plan and notes, schedules, and the agent's own MCP servers. Each call is the agent's, gated and audited as Nouride's own.",
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: deps.lent.definitions(session).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      const result = await deps.lent.call(session, name, args);
      return ok(id, { content: [{ type: "text", text: result.content }], isError: result.isError === true });
    }
    default:
      return fail(id, -32601, `method not found: ${method ?? "(none)"}`);
  }
}

export function mountAgentMcp(app: Hono, deps: AgentMcpDeps): void {
  app.all("/mcp/agent", async (c) => {
    // The socket's address, as the server hands it over (`web/server.ts`) — never a header a caller writes.
    const address = (c.env as { clientAddress?: string | null } | undefined)?.clientAddress ?? "";
    if (!LOOPBACK.test(address)) return c.json({ error: "not_found", path: "/mcp/agent" }, 404);
    if (c.req.method !== "POST") return c.body(null, 405, { allow: "POST" });
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const session = token ? deps.lent.resolve(token, c.req.header(CONVERSATION_HEADER)) : null;
    if (!session) return c.json({ error: "this path answers an external agent's CLI, with the token its session was given" }, 401);
    return await serveRpc(c, (message) => answer(deps, session, message), (message, err) => log.warn("an external agent's tool call failed", { method: message.method, agent_id: session.agentId, error: err instanceof Error ? (err.stack ?? err.message) : String(err) }));
  });
}
