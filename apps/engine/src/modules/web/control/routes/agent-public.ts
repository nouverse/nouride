/**
 * An open agent's conversations with the public, for its own page.
 *
 * Anyone may write to an agent open to everyone, so its conversations on the connections it owns are no person's:
 * listed with everybody's chats they would bury the household's own, and nobody in People would be beside them. They are
 * left out of those lists (`openAgentsOn`) and listed here, for an admin: who wrote, what they first asked, when,
 * and whether they are blocked. A row is opened as any conversation is, and its sender blocked on the Access routes.
 *
 * Registered before `routes/agents.ts`, whose `/agents/:id/:action` would take `public` as an action.
 */

import type { AgentPublic, PublicConversation } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import { openAgentsOn } from "../agent-open.ts";
import { clampNumber } from "../payloads.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { kindOf } from "../whose.ts";

export function registerAgentPublicRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/agents/:id/public", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    const agentId = c.req.param("id");
    if (!deps.registry.get(agentId)) return c.json({ error: `no agent "${agentId}"` }, 404);
    const limit = clampNumber(c.req.query("limit"), 30, 1, 100);
    const before = clampNumber(c.req.query("before"), 0, 0, Number.MAX_SAFE_INTEGER);
    // Its own connections while it is open: closed, it has no public, and what it said then is among everybody's chats.
    const options = { agentId, gateways: openAgentsOn(deps).find((open) => open.agentId === agentId)?.gateways ?? [] };
    const sessions = deps.sessions?.list({ ...options, limit, ...(before > 0 ? { before } : {}) }) ?? [];
    const titles = deps.turns?.titles() ?? new Map<string, string>();
    // `opened_by` is `<platform>:<their id>`: the id is what the connection knows them by.
    const senderOf = (openedBy: string | undefined) => (openedBy ? openedBy.slice(openedBy.indexOf(":") + 1) : null);
    const names = new Map([...new Set(sessions.map((session) => session.gatewayId))].map((gatewayId) => [gatewayId, deps.openDoor?.names(agentId, gatewayId) ?? new Map<string, string>()]));
    const conversations = sessions.map((session): PublicConversation => {
      const id = senderOf(session.openedBy);
      return {
        sessionId: session.id,
        gatewayId: session.gatewayId,
        chatId: session.chatId,
        kind: kindOf(deps, session.gatewayId, session.chatId) === "group" ? "group" : "private",
        sender: id ? { id, name: names.get(session.gatewayId)?.get(id) ?? null, blocked: deps.access?.get(session.gatewayId, id)?.status === "blocked" } : null,
        title: (titles.get(session.id) ?? "").slice(0, 120),
        updatedAt: session.updatedAt,
      };
    });
    return c.json({
      conversations,
      total: deps.sessions?.count(options) ?? 0,
      ...(sessions.length === limit ? { nextBefore: sessions[sessions.length - 1]!.updatedAt } : {}),
    } satisfies AgentPublic);
  });
}
