/**
 * Logging remote MCP servers in (0.7.19): a login started, finished and logged out — Connect on the MCP pages and
 * `nouride mcp login`. Admin only, as saving a server is: a login decides which account an agent's tools act as.
 *
 * A login is the library's (`/mcp/library/:server/oauth`), used by every agent that has none of its own, or one agent's
 * (`/agents/:id/mcp/:server/oauth`) — that agent's own when it has one, the library's when it uses that.
 *
 * What comes back is an address to open and an outcome — never a token, a code or a verifier. Finishing takes the code
 * and the state in the body, or the address the browser ended on, so neither is in a URL this daemon is asked for.
 */

import type { Context } from "hono";
import { SHARED_LOGIN } from "@nouride/persona";
import { atLeast, type Principal } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps, ControlEnv } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_RUNNING } from "../plain.ts";

type ControlContext = Context<{ Variables: { principal: Principal }; Bindings: ControlEnv }>;

/** Who a login is bound to: the same person finishes what they started. */
const whoIs = (principal: Principal): string => `${principal.kind}:${principal.actor}`;

export function registerMcpOAuthRoutes(control: ControlApp, deps: ControlDeps): void {
  /** Whose login a route means: the library's, or the one this agent's server uses. */
  const holderOf = (agentId: string | undefined, server: string) => (agentId === undefined ? SHARED_LOGIN : deps.mcpLogins!.holderOf(agentId, server));

  const start = async (c: ControlContext, agentId: string | undefined) => {
    if (!deps.mcpLogins) return c.json({ error: "logging in to MCP servers is not available here", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const server = c.req.param("server") ?? "";
    const started = await deps.mcpLogins.start({
      holder: holderOf(agentId, server),
      server,
      by: whoIs(principal),
      // For an authorization server that registers nobody: an application registered with it by hand.
      ...(typeof body.clientId === "string" ? { clientId: body.clientId } : {}),
      ...(typeof body.clientSecret === "string" ? { clientSecret: body.clientSecret } : {}),
    });
    if ("error" in started) return c.json({ error: started.error, plain: "Signing in to this connector could not start. Check its settings, and try again." }, started.status);
    return c.json({ url: started.url });
  };
  control.post("/mcp/library/:server/oauth/start", (c) => start(c, undefined));
  control.post("/agents/:id/mcp/:server/oauth/start", (c) => start(c, c.req.param("id")));

  control.post("/mcp/oauth/finish", async (c) => {
    if (!deps.mcpLogins) return c.json({ error: "logging in to MCP servers is not available here", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const finished = await deps.mcpLogins.finish({ code: body.code, state: body.state, url: body.url }, whoIs(principal), principal.actor);
    if ("error" in finished) return c.json({ error: finished.error, plain: "Signing in did not finish. Start it again from the connector." }, finished.status);
    return c.json(finished satisfies { ok: true; holder: string; server: string; scope?: string });
  });

  const logout = async (c: ControlContext, agentId: string | undefined) => {
    if (!deps.mcpLogins) return c.json({ error: "logging in to MCP servers is not available here", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const server = c.req.param("server") ?? "";
    const done = await deps.mcpLogins.logout(holderOf(agentId, server), server, principal.actor);
    if ("error" in done) return c.json({ error: done.error, plain: "The connector's sign-in was not removed. Reload the page, and try again." }, done.status);
    return c.json(done);
  };
  control.delete("/mcp/library/:server/oauth", (c) => logout(c, undefined));
  control.delete("/agents/:id/mcp/:server/oauth", (c) => logout(c, c.req.param("id")));
}
