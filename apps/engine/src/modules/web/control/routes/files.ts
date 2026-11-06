/**
 * Persona files and the daemon config, as text.
 *
 * Registered before `agents.ts`: Hono matches in registration order, and `POST /agents/:id/:action`
 * would otherwise swallow every three-segment agent route declared after it.
 */

import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { CHANGED_MEANWHILE, NOT_RUNNING, NOT_SAVED } from "../plain.ts";

export function registerFileRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/agents/:id/files", async (c) => {
    if (!deps.files) return c.json({ error: "file editing is not available on this daemon", plain: NOT_RUNNING }, 501);
    const files = await deps.files.listForAgent(c.req.param("id"));
    if (!files) return c.json({ error: "no such agent" }, 404);
    return c.json({ files });
  });

  control.get("/agents/:id/files/:name", async (c) => {
    if (!deps.files) return c.json({ error: "file editing is not available on this daemon", plain: NOT_RUNNING }, 501);
    const result = await deps.files.read(c.req.param("id"), c.req.param("name"));
    return "error" in result ? c.json({ error: result.error, plain: "This file cannot be opened here." }, 400) : c.json(result);
  });

  control.post("/agents/:id/files/:name", async (c) => {
    if (!deps.files) return c.json({ error: "file editing is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (typeof body.content !== "string") return c.json({ error: "content must be a string" }, 400);

    const result = await deps.files.write({
      agentId: c.req.param("id"),
      name: c.req.param("name"),
      content: body.content,
      actor: principal.actor,
      ...(typeof body.expected === "string" ? { expected: body.expected } : {}),
    });
    if (!result.ok) {
      const conflict = "conflict" in result && result.conflict === true;
      return c.json({ error: result.error, plain: conflict ? CHANGED_MEANWHILE : NOT_SAVED }, conflict ? 409 : 400);
    }
    // The one file a coding CLI reads that its sessions are not compared by — the agent's own notes (`writeInstruction`).
    if (c.req.param("name") === "MEMORY.md") deps.externalAgents?.renew(c.req.param("id"));
    return c.json(result);
  });

  control.get("/config", async (c) => {
    if (!deps.files) return c.json({ error: "file editing is not available on this daemon", plain: NOT_RUNNING }, 501);
    return c.json({ content: await deps.files.readDaemonConfig(), path: deps.files.daemonConfigPath() });
  });

  control.post("/config", async (c) => {
    if (!deps.files) return c.json({ error: "file editing is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    // The daemon's own settings decide who may reach it and what the agent may run. That is not an
    // operator-level change even though everything else in the file editor is.
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (typeof body.content !== "string") return c.json({ error: "content must be a string" }, 400);

    const expected = typeof body.expected === "string" ? body.expected : undefined;
    const result = await deps.files.writeDaemonConfig(body.content, principal.actor, expected);
    if (result.ok) return c.json(result);
    return c.json({ error: result.error, ...(result.conflict ? { conflict: true } : {}), plain: result.conflict ? CHANGED_MEANWHILE : NOT_SAVED }, result.conflict ? 409 : 400);
  });
}
