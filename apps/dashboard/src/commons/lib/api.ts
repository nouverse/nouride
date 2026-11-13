/**
 * API client.
 *
 * Same-origin in production (the engine serves this SPA), proxied by Vite in dev —
 * so paths are always root-relative and there is no base URL to configure.
 *
 * Authentication is a cookie the browser holds and never reads: the session token is `httpOnly`, so
 * there is no token in `localStorage` for a script on this page to find. `credentials: "same-origin"`
 * is what carries it, and it is on every request rather than on the ones that seemed to need it.
 *
 * What each call sends and answers is a type of `@nouride/wire`, which the engine's routes import too; why a field
 * newer than the oldest daemon this page can meet is optional is said there.
 */

import { control, request } from "./api.client";
import type { HealthPayload, StatusPayload } from "@nouride/wire";

// Re-exported: it was declared here and callers throughout the app catch it by name.
export { ApiError } from "./api.client";
import { setupApi } from "./api.setup";
import { agentToolsApi } from "./api.agent-tools";
import { externalAgentsApi } from "./api.external-agents";
import { mcpCatalogApi } from "./api.mcp-catalog";
import { mcpLibraryApi } from "./api.mcp-library";
import { updateApi } from "./api.update";
import { toolBudgetApi } from "./api.tool-budget";
import { webSearchApi } from "./api.web-search";
import { jobsApi } from "./api.jobs";
import { memoryApi } from "./api.memory";
import { knowledgeApi } from "./api.knowledge";
import { mcpServerApi } from "./api.mcp-server";
import { llmGatewayApi } from "./api.llm-gateway";
import { peopleApi } from "./api.people";
import { groupsApi } from "./api.groups";
import { accessApi } from "./api.access";
import { skillsApi } from "./api.skills";
import { secretsApi } from "./api.secrets";
import { advisoriesApi } from "./api.advisories";
import { authApi } from "./api.auth";
import { settingsApi } from "./api.settings";
import { agentsApi } from "./api.agents";
import { chatApi } from "./api.chat";
import { notesApi } from "./api.notes";
import { logsApi } from "./api.logs";
import { systemApi } from "./api.system";
import { cronApi } from "./api.cron";
import { turnsApi } from "./api.turns";
import { tiersApi } from "./api.tiers";
import { missionsApi } from "./api.missions";

export const api = {
  health: () => request<HealthPayload>("/api/health"),
  status: () => request<StatusPayload>(`${control}/status`),

  ...setupApi,
  ...agentToolsApi,
  ...externalAgentsApi,
  ...mcpCatalogApi,
  ...mcpLibraryApi,
  ...authApi,
  ...settingsApi,
  ...agentsApi,
  ...chatApi,
  ...notesApi,
  ...logsApi,
  ...systemApi,
  ...cronApi,
  ...turnsApi,

  ...skillsApi,
  ...secretsApi,
  ...advisoriesApi,

  ...updateApi,
  ...toolBudgetApi,
  ...webSearchApi,
  ...jobsApi,
  ...memoryApi,
  ...knowledgeApi,
  ...mcpServerApi,
  ...llmGatewayApi,
  ...peopleApi,
  ...groupsApi,
  ...accessApi,
  ...tiersApi,
  ...missionsApi,
};
