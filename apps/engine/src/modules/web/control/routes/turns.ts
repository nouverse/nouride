/**
 * Turns, read whole — what `nouride turns` asks (D2).
 *
 * The dashboard reads a turn through its conversation; this reads one by its id, with what the transcript does not
 * carry: each model call with its tokens, cost, latency and retries, and the audit log's rows for its tool calls.
 */

import type { ControlApp, ControlDeps } from "../types.ts";

/** Turns a list asks for, at most. Newest first, so the bound only ever cuts the old end. */
const LIST_MAX = 200;

export function registerTurnRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/turns", (c) => {
    if (!deps.turnInspector) return c.json({ error: "turn records are not available" }, 501);
    const asked = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, LIST_MAX) : 20;
    const agentId = c.req.query("agent")?.trim();
    return c.json({ turns: deps.turnInspector.recent({ limit, ...(agentId ? { agentId } : {}) }) });
  });

  control.get("/turns/:id", (c) => {
    if (!deps.turnInspector) return c.json({ error: "turn records are not available" }, 501);
    const id = c.req.param("id");
    const found = deps.turnInspector.inspect(id);
    if (!found) {
      return c.json({ error: `no turn ${id}`, note: "`nouride turns` lists the newest; a shortened id has to name one turn", plain: "That record is not there any more." }, 404);
    }
    return c.json(found);
  });
}
