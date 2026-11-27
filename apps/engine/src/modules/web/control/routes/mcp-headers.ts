/**
 * One header of an MCP server, set or taken off (issue #43): of the library's server, or of one agent's switch on it
 * (`?agent=`). `PUT` with `{ value }` or `{ secret }` sets it, `DELETE` takes it off; the server's other keys and every
 * agent's switch stay as they were (`config/settings/mcp-headers.ts`).
 */

import type { Context } from "hono";
import { atLeast, type Principal } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps, ControlEnv } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NO_SETTINGS, notSaved } from "../plain.ts";
import { MCP_FIELDS, packsOf } from "./mcp.ts";

type ControlContext = Context<{ Variables: { principal: Principal }; Bindings: ControlEnv }>;
type Body = Record<string, unknown>;

export function registerMcpHeaderRoutes(control: ControlApp, deps: ControlDeps): void {
  const header = async (c: ControlContext, body: Body | null) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const agentId = c.req.query("agent");
    const result = await deps.settings.changeServerHeader({
      packs: packsOf(deps),
      actor: principal.actor,
      server: c.req.param("name") ?? "",
      header: c.req.param("header") ?? "",
      ...(typeof body?.value === "string" ? { value: body.value } : {}),
      ...(typeof body?.secret === "string" && body.secret ? { secret: body.secret } : {}),
      ...(agentId ? { agentId } : {}),
    });
    return result.ok ? c.json(result satisfies { ok: true; restartRequired: boolean }) : c.json({ error: result.error, plain: notSaved(result.field && MCP_FIELDS[result.field]) }, 400);
  };
  control.put("/mcp/library/:name/headers/:header", async (c) => {
    const body = ((await jsonBody(c)) ?? {}) as Body;
    if (typeof body.value !== "string" && !(typeof body.secret === "string" && body.secret)) return c.json({ error: "send { value } or { secret }", plain: notSaved(undefined) }, 400);
    return await header(c, body);
  });
  control.delete("/mcp/library/:name/headers/:header", async (c) => await header(c, null));
}
