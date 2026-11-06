/**
 * `POST /mcp` — Nouride as an MCP server, for other tools (`docs/SPEC.md` §12.3).
 *
 * The protocol only: JSON-RPC over HTTP, answered as JSON (MCP's Streamable HTTP without a stream:
 * nothing here pushes), in MCP 2025-06-18, 2025-03-26 or 2024-11-05 — whichever of them the client asks for, and the
 * newest for a client that asks for another. Outside `/api/control` on purpose, like `/hooks`: it does not take the
 * dashboard's session, only a token of its own — `Authorization: Bearer nmcp_…`, made with
 * `nouride mcp-server token create`, belonging to a person and naming its agents and scopes.
 *
 * Off (404, as if absent) until `[mcp_server] enabled`. What a token reaches is `modules/mcp-server`'s.
 */

import type { Context, Hono } from "hono";
import { createLogger, type GlobalConfig } from "@nouride/shared";
import { MCP_PROTOCOL_VERSIONS, negotiateVersion } from "@nouride/mcp";
import type { McpSurface } from "@/modules/mcp-server/surface.ts";
import type { McpToken, McpTokenPort } from "@/modules/mcp-server/tokens.store.ts";

const log = createLogger("web.mcp");

export interface McpDeps {
  config: Pick<GlobalConfig, "mcpServer">;
  tokens: Pick<McpTokenPort, "use">;
  surface: McpSurface;
  version: string;
  now?: () => number;
}

export interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type Reply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

export const ok = (id: Message["id"], result: unknown): Reply => ({ jsonrpc: "2.0", id: id ?? null, result });
export const fail = (id: Message["id"], code: number, message: string): Reply => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function answer(deps: McpDeps, token: McpToken, message: Message): Promise<Reply | null> {
  const { id, method } = message;
  const params = message.params ?? {};
  // A notification wants no answer — `notifications/initialized` is the one every client sends.
  if (id === undefined || id === null) return null;
  switch (method) {
    case "initialize":
      return ok(id, {
        // The client's version when it is one spoken here, else the newest (`negotiateVersion`). Until 0.7.13 any
        // string a client sent came back as though agreed — `2099-01-01` included — and a client sending none got 2024-11-05.
        protocolVersion: negotiateVersion(params.protocolVersion),
        // Nothing is ever pushed from here, so no `listChanged`: a client has no stream to open for it (GET is 405).
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: "nouride", version: deps.version },
        instructions: deps.surface.instructions(token),
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: deps.surface.offered(token).tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      const result = await deps.surface.call(token, name, args);
      return ok(id, { content: [{ type: "text", text: result.text }], isError: result.isError });
    }
    case "prompts/list":
      return ok(id, { prompts: deps.surface.offered(token).prompts });
    case "prompts/get": {
      const text = deps.surface.prompt(token, typeof params.name === "string" ? params.name : "");
      return text === null ? fail(id, -32602, "no such prompt") : ok(id, { messages: [{ role: "user", content: { type: "text", text } }] });
    }
    case "resources/list":
      return ok(id, { resources: deps.surface.offered(token).resources });
    case "resources/read": {
      const uri = typeof params.uri === "string" ? params.uri : "";
      const text = deps.surface.resource(token, uri);
      return text === null ? fail(id, -32602, "no such resource") : ok(id, { contents: [{ uri, mimeType: "text/markdown", text }] });
    }
    default:
      return fail(id, -32601, `method not found: ${method ?? "(none)"}`);
  }
}

export function mountMcp(app: Hono, deps: McpDeps): void {
  app.all("/mcp", async (c) => {
    if (!deps.config.mcpServer.enabled) return c.json({ error: "not_found", path: "/mcp" }, 404);
    if (c.req.method !== "POST") return c.body(null, 405, { allow: "POST" });

    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const token = bearer ? deps.tokens.use(bearer, (deps.now ?? Date.now)()) : null;
    if (!token) return c.json({ error: "a Nouride MCP token is required. Create one with nouride mcp-server token create" }, 401, { "www-authenticate": 'Bearer realm="nouride"' });
    return await serveRpc(c, (message) => answer(deps, token, message), (message, err) => log.warn("mcp call failed", { method: message.method, token_id: token.id, error: String(err) }));
  });
}

/**
 * One POST of JSON-RPC — a message or a batch — each answered by `answer`, as MCP's Streamable HTTP without a stream
 * has it. Shared by `/mcp` and an external agent's `/mcp/agent` (`agent.ts`), so the two cannot come to differ.
 */
export async function serveRpc(c: Context, answer: (message: Message) => Promise<Reply | null>, failed: (message: Message, err: unknown) => void): Promise<Response> {
  // What a client says it negotiated, on every request after `initialize` (2025-06-18). One this server does not speak
  // is refused with 400, as the spec has it; none at all is a client from before the header, and is answered as ever.
  const version = c.req.header("mcp-protocol-version");
  if (version !== undefined && !MCP_PROTOCOL_VERSIONS.includes(version)) {
    return c.json(fail(null, -32600, `unsupported MCP-Protocol-Version "${version}": this server speaks ${MCP_PROTOCOL_VERSIONS.join(", ")}`), 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(fail(null, -32700, "parse error"), 400);
  }
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as Message[];
  if (messages.length === 0 || messages.some((m) => !m || typeof m !== "object" || m.jsonrpc !== "2.0")) {
    return c.json(fail(null, -32600, "invalid request"), 400);
  }

  const replies: Reply[] = [];
  for (const message of messages) {
    try {
      const reply = await answer(message);
      if (reply) replies.push(reply);
    } catch (err) {
      failed(message, err);
      replies.push(fail(message.id, -32603, "internal error"));
    }
  }
  if (replies.length === 0) return c.body(null, 202);
  return c.json(batch ? replies : replies[0]);
}
