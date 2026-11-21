/**
 * Deleting an agent (`agent-delete.ts`): what it would take, and the delete itself. Admin only, and for the delete the
 * agent's id typed again in the body: the dashboard asks for it in its dialog and the CLI at its prompt, and a request
 * without it is one somebody did not mean. Registered before `/agents/:id/:action`, which takes any word.
 */

import type { AgentDeleted, AgentDeletion } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import { deleteAgent, summarize, type AgentDeleteDeps } from "../agent-delete.ts";
import { jsonBody } from "../payloads.ts";
import type { ControlApp, ControlDeps } from "../types.ts";

/** A refusal's status: gone is not found, the orchestrator is a state to change first. */
const STATUS = { missing: 404, orchestrator: 409 } as const;

export function registerAgentDeleteRoutes(control: ControlApp, deps: ControlDeps): void {
  const reach = (): AgentDeleteDeps => ({ ...deps, mcp: deps.mcp, account: deps.agentAccounts?.remove, ownUsers: deps.agentAccounts?.own });

  control.get("/agents/:id/delete", async (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    const found = await summarize(reach(), c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error, plain: found.plain }, STATUS[found.why]);
    return c.json(found satisfies AgentDeletion);
  });

  control.post("/agents/:id/delete", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const id = c.req.param("id");
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (body.confirm !== id) {
      return c.json({ error: `confirm must be the agent's id, "${id}", typed again`, plain: "Type the agent's id to confirm, exactly as it is shown." }, 400);
    }
    const done = await deleteAgent(reach(), id, principal.actor);
    if ("error" in done) return c.json({ error: done.error, plain: done.plain }, STATUS[done.why]);
    return c.json(done satisfies AgentDeleted);
  });
}
