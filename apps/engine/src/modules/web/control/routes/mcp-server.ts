/**
 * Nouride as an MCP server (`modules/mcp-server`, served at `/mcp`): switched on and off, and its
 * tokens made, listed and revoked.
 *
 * An admin's, all of it: a token is a new way into what is kept about a person. It is made for a
 * person with a key, for agents that exist, with the scopes it names, and its value is in the answer
 * once and nowhere else.
 */

import type { McpTokenView } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import { DEFAULT_SCOPES, parseScopes } from "@/modules/mcp-server/scopes.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { INCOMPLETE, NOT_RUNNING, NOT_SAVED, NO_SETTINGS } from "../plain.ts";

/** What a client is called in its notes' source — `mcp:zed`. A path segment, so a slug. */
const LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a new token lasts, in days: 90 when the request does not say, 0 for never, at most ten years.
 *
 * A token used to last until somebody revoked it — a credential pasted into an editor's settings, good for as long
 * as nobody remembered it was there. Ninety days is a quarter: long enough that a client is not set up again every
 * week, short enough that a forgotten one stops. Never is still there, asked for by name.
 */
function ttlDays(value: unknown): number | string {
  if (value === undefined || value === null) return 90;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3650) {
    return "ttl_days is a whole number of days from 0 (never expires) to 3650";
  }
  return value;
}

export function registerMcpServerRoutes(control: ControlApp, deps: ControlDeps): void {
  /** The CLI's words, the status, and the page's (0.8.20). */
  function refusal(principal: Parameters<typeof atLeast>[0]): [string, 403 | 503, string] | null {
    if (!atLeast(principal, "admin")) return ["admin only: a token is a new way into someone's memory", 403, "Only an admin can let other apps in, or take a key back."];
    if (!deps.mcpTokens) return ["the MCP server is not wired in this process", 503, NOT_RUNNING];
    return null;
  }

  control.get("/mcp-server", (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0], plain: no[2] }, no[1]);
    return c.json({ enabled: deps.ctx.config.mcpServer.enabled, tokens: deps.mcpTokens!.list() } satisfies { enabled: boolean; tokens: McpTokenView[] });
  });

  control.put("/mcp-server", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal);
    if (no) return c.json({ error: no[0], plain: no[2] }, no[1]);
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const body = (await jsonBody(c)) as Record<string, unknown> | null;
    if (typeof body?.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
    const result = await deps.settings.setMcpServerEnabled({ enabled: body.enabled, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    return c.json({ enabled: deps.ctx.config.mcpServer.enabled } satisfies { enabled: boolean });
  });

  control.post("/mcp-server/tokens", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal);
    if (no) return c.json({ error: no[0], plain: no[2] }, no[1]);
    const body = (await jsonBody(c)) as Record<string, unknown> | null;
    const person = typeof body?.person === "string" ? body.person : "";
    if (!deps.ctx.config.people.some((entry) => entry.key === person)) {
      return c.json({ error: "person must be someone in [[people]] with a key, by key", plain: "Pick someone from the list of people." }, 400);
    }
    const agents = Array.isArray(body?.agents) ? body.agents.filter((id): id is string => typeof id === "string") : [];
    if (agents.length === 0 || agents.some((id) => !deps.registry.get(id))) {
      return c.json({ error: "agents must name at least one agent, each one that exists" }, 400);
    }
    const label = typeof body?.label === "string" ? body.label : "";
    if (!LABEL.test(label)) return c.json({ error: "label is the client's name as a slug: zed, codex, claude_code", plain: "The app's name takes small letters, digits and underscores, like zed or codex." }, 400);
    const scopes = body?.scopes === undefined ? [...DEFAULT_SCOPES] : parseScopes(Array.isArray(body.scopes) ? body.scopes.map(String) : []);
    if ("error" in scopes) return c.json({ error: scopes.error, plain: INCOMPLETE }, 400);
    const ttl = ttlDays(body?.ttl_days);
    if (typeof ttl === "string") return c.json({ error: ttl, plain: "How long a key lasts is a whole number of days: 0 for always, up to 3650." }, 400);

    const now = Date.now();
    const expiresAt = ttl === 0 ? null : now + ttl * DAY_MS;
    const made = deps.mcpTokens!.create({ person, agents, scopes, label, now, expiresAt });
    deps.audit?.record({ action: "mcp_token_created", actor: principal.actor, details: { id: made.token.id, person, agents, scopes, label, expires_at: expiresAt } });
    return c.json({ ...made, enabled: deps.ctx.config.mcpServer.enabled } satisfies { token: McpTokenView; value: string; enabled: boolean }, 201);
  });

  control.delete("/mcp-server/tokens/:id", (c) => {
    const principal = c.get("principal");
    const no = refusal(principal);
    if (no) return c.json({ error: no[0], plain: no[2] }, no[1]);
    const id = c.req.param("id");
    if (!deps.mcpTokens!.revoke(id, Date.now())) return c.json({ error: `no live token ${id}`, plain: "That key is not there any more. Reload the page." }, 404);
    deps.audit?.record({ action: "mcp_token_revoked", actor: principal.actor, details: { id } });
    return c.json({ id, revoked: true } satisfies { id: string; revoked: boolean });
  });
}
