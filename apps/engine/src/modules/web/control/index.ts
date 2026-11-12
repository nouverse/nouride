/**
 * Control API — the surface the CLI drives.
 *
 * Guarded by a token generated into `data/.control-token` (0640: the launcher's group reads it) on first boot, which the CLI
 * reads when it runs on the same machine. That replaces the earlier unauthenticated dev
 * endpoint: "local only" is not enforceable when the daemon binds 0.0.0.0 in a container, and an
 * open route that runs tools and spends model budget is not something to leave to a comment.
 *
 * Every route here is an operator action, so every route is audited.
 *
 * This file wires; it does not handle. Each `register*Routes` below owns one domain, and the order
 * they are called in is load-bearing — Hono matches routes in registration order, so a module whose
 * paths are more specific has to run before one that ends in a wildcard segment. The two that
 * actually collide are called out where they are registered.
 */

import { Hono } from "hono";
import type { Principal } from "@/modules/users/auth.ts";
import { controlGuard } from "./guard.ts";
import type { ControlApp, ControlDeps, ControlEnv } from "./types.ts";
import { registerSetupRoutes } from "./routes/setup.ts";
import { registerFileRoutes } from "./routes/files.ts";
import { registerSkillRootRoutes } from "./routes/skill-roots.ts";
import { registerDiagnosticRoutes } from "./routes/diagnostics.ts";
import { registerConversationRoutes } from "./routes/conversations.ts";
import { registerChatListRoutes } from "./routes/chat-list.ts";
import { registerChatRoutes } from "./routes/chat.ts";
import { registerNotesRoutes } from "./routes/notes.ts";
import { registerMissionRoutes } from "./routes/missions.ts";
import { registerRoomRoutes } from "./routes/rooms.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerGatewayRoutes } from "./routes/gateways.ts";
import { registerProviderRoutes } from "./routes/providers.ts";
import { registerSecretRoutes } from "./routes/secrets.ts";
import { registerUserRoutes } from "./routes/users.ts";
import { registerApprovalRoutes } from "./routes/approvals.ts";
import { registerAccessRoutes } from "./routes/access.ts";
import { registerPolicyRoutes } from "./routes/policy.ts";
import { registerJobQuietRoutes } from "./routes/job-quiet.ts";
import { registerMissionSettingsRoutes } from "./routes/mission-settings.ts";
import { registerTierRoutes } from "./routes/tiers.ts";
import { registerDelegateRoutes } from "./routes/delegate.ts";
import { registerMentionRoutes } from "./routes/mentions.ts";
import { registerWebSearchRoutes } from "./routes/web-search.ts";
import { registerPeopleRoutes } from "./routes/people.ts";
import { registerGroupRoutes } from "./routes/groups.ts";
import { registerKnownChatRoutes } from "./routes/known-chats.ts";
import { registerJobRoutes } from "./routes/jobs.ts";
import { registerCronRoutes } from "./routes/cron.ts";
import { registerWebhookRoutes } from "./routes/webhooks.ts";
import { registerAutomationRoutes } from "./routes/automations.ts";
import { registerDraftRoutes } from "./routes/drafts.ts";
import { registerSkillHubRoutes } from "./routes/skills-hub.ts";
import { registerMcpCatalogRoutes } from "./routes/mcp-catalog.ts";
import { registerMcpOAuthRoutes } from "./routes/mcp-oauth.ts";
import { registerMcpRoutes } from "./routes/mcp.ts";
import { registerSkillRoutes } from "./routes/skills.ts";
import { registerMemoryRoutes } from "./routes/memory.ts";
import { registerMemoryDocumentRoutes } from "./routes/memory-documents.ts";
import { registerMemoryTagRoutes } from "./routes/memory-tags.ts";
import { registerKnowledgeRoutes } from "./routes/knowledge.ts";
import { registerTurnRoutes } from "./routes/turns.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerMcpServerRoutes } from "./routes/mcp-server.ts";
import { registerLlmGatewayRoutes } from "./routes/llm-gateway.ts";
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerAgentToolRoutes } from "./routes/agent-tools.ts";
import { registerExternalAgentRoutes } from "./routes/external-agents.ts";
import { registerUpdateRoutes } from "./routes/update.ts";
import { registerApplianceRoutes } from "./routes/appliance.ts";

export { ensureControlToken } from "./token.ts";
export type { ControlDeps } from "./types.ts";

export function mountControlRoutes(app: Hono, deps: ControlDeps): void {
  const control: ControlApp = new Hono<{
    Variables: { principal: Principal };
    Bindings: ControlEnv;
  }>();

  control.use("*", controlGuard(deps));

  registerSetupRoutes(control, deps);
  // `/llm-gateway` — the switch the setup wizard and the LLM Gateway page turn; its own prefix.
  registerLlmGatewayRoutes(control, deps);
  // Before `registerAgentRoutes`: `/agents/:id/files` has to be matched before that module's
  // catch-all `POST /agents/:id/:action`.
  registerFileRoutes(control, deps);
  // Before it too: `POST /agents/:id/skill-roots` is three segments.
  registerSkillRootRoutes(control, deps);
  registerDiagnosticRoutes(control, deps);
  registerConversationRoutes(control, deps);
  registerChatListRoutes(control, deps);
  registerChatRoutes(control, deps);
  registerNotesRoutes(control, deps);
  registerMissionRoutes(control, deps);
  registerRoomRoutes(control, deps);
  registerAuthRoutes(control, deps);
  registerGatewayRoutes(control, deps);
  registerProviderRoutes(control, deps);
  registerSecretRoutes(control, deps);
  registerUserRoutes(control, deps);
  registerApprovalRoutes(control, deps);
  registerAccessRoutes(control, deps);
  registerPolicyRoutes(control, deps);
  registerJobQuietRoutes(control, deps);
  registerMissionSettingsRoutes(control, deps);
  // Before `registerAgentRoutes`, whose `/agents/:id/:action` would claim `/agents/:id/tiers`.
  registerTierRoutes(control, deps);
  // Before the agent module, for its `/agents/:id/delegate` — the agent module ends in `POST /agents/:id/:action`.
  registerDelegateRoutes(control, deps);
  registerMentionRoutes(control, deps);
  registerWebSearchRoutes(control, deps);
  registerPeopleRoutes(control, deps);
  registerGroupRoutes(control, deps);
  registerKnownChatRoutes(control, deps);
  registerJobRoutes(control, deps);
  registerCronRoutes(control, deps);
  registerWebhookRoutes(control, deps);
  registerAutomationRoutes(control, deps);
  // `/update*` — its own prefix, and registered before the agent module for the rule this file
  // keeps rather than for a collision that exists today.
  registerUpdateRoutes(control, deps);
  // `/appliance/*` — forwarded to the Device-only plugin; its own prefix, before the agent module.
  registerApplianceRoutes(control, deps);
  // Last, because it ends in `POST /agents/:id/:action`.
  // `/skills/drafts*` before `/skills/:name/source`, for the same reason: the two do not collide
  // today, and specific-before-generic is the rule rather than the current segment counts.
  registerDraftRoutes(control, deps);
  registerSkillHubRoutes(control, deps);
  registerMcpCatalogRoutes(control, deps);
  // `/agents/:id/mcp/:server/oauth*` and `/mcp/oauth/finish` — before the agent module, specific paths first.
  registerMcpOAuthRoutes(control, deps);
  // Before the agent routes: `POST /agents/:id/mcp` would otherwise be their `/agents/:id/:action`.
  registerMcpRoutes(control, deps);
  // `/skills*` — the pool-wide view. Registered before the agent module, which owns the per-agent
  // `/agents/:id/skills`: different prefixes, so nothing collides today, and specific-first is the
  // rule this file keeps rather than something to rediscover.
  registerSkillRoutes(control, deps);
  // `/memories*` — its own prefix, so nothing here collides. Before the agent module for the same
  // reason everything else is: specific paths first, as a rule rather than as a fact about today's
  // segment counts.
  registerMemoryRoutes(control, deps);
  registerMemoryDocumentRoutes(control, deps);
  registerMemoryTagRoutes(control, deps);
  // `/knowledge*` — the knowledge base (0.8.20): its own prefix.
  registerKnowledgeRoutes(control, deps);
  registerTurnRoutes(control, deps);
  registerEventRoutes(control, deps);
  registerMcpServerRoutes(control, deps);
  // Before the agent module: its `/agents/:id/:action` would take `tools` and `default` as actions.
  registerAgentToolRoutes(control, deps);
  registerExternalAgentRoutes(control, deps);
  registerAgentRoutes(control, deps);

  app.route("/api/control", control);
}
