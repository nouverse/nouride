/**
 * One agent's own files, MCP servers, skills, model and approvals level, and pausing it.
 *
 * Split out of `api.ts`, which had grown past the size cap with every endpoint group inline, and spread
 * into `api` like the others: `api.x()` reads the same at every call site, and the types stay in `api.ts`,
 * where `scripts/check-wire.ts` compares them with the daemon's.
 */

import { control, post, request } from "./api.client";
import type { AgentSkill, FallbackPair, FileSummary, McpServer } from "./api";

/** The levels an agent's effort can be set to (`LLM_EFFORTS` in the daemon), and "default" for the install's. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export const agentsApi = {
  /** The library's servers with this agent's word on each, and any its pack still declares itself. */
  agentMcp: (agent: string) => request<{ servers: McpServer[]; error?: string }>(`${control}/agents/${agent}/mcp`),

  saveAgentModel: (agent: string, input: { provider: string; model: string }) =>
    post<{ ok: true }>(`${control}/agents/${agent}/model`, input),

  /** How long its model thinks: a level of `EFFORT_LEVELS`, or "default" for the install's (0.8.17). */
  saveAgentEffort: (agent: string, effort: string) => post<{ ok: true }>(`${control}/agents/${agent}/effort`, { effort }),

  /** Who answers when this agent's model cannot, in order; empty for none. */
  saveAgentFallbacks: (agent: string, fallbacks: FallbackPair[]) =>
    post<{ ok: true }>(`${control}/agents/${agent}/fallbacks`, { fallbacks }),

  agentSkills: (agent: string) =>
    request<{ skills: AgentSkill[]; editable: boolean }>(`${control}/agents/${agent}/skills`),

  // What changed, not the whole map: the daemon merges it into skills.toml as it is when the save lands, so a
  // switch flipped in another tab meanwhile stays. The whole map was a last write that undid the other tab's.
  saveAgentSkills: (agent: string, changes: Record<string, boolean>) =>
    post<{ ok: true }>(`${control}/agents/${agent}/skills`, { changes }),

  agentFiles: (agent: string) => request<{ files: FileSummary[] }>(`${control}/agents/${agent}/files`),

  readFile: (agent: string, name: string) =>
    request<{ content: string }>(`${control}/agents/${agent}/files/${name}`),

  writeFile: (agent: string, name: string, content: string, expected?: string) =>
    post<{ ok: true }>(`${control}/agents/${agent}/files/${name}`, { content, expected }),

  agentAction: (id: string, action: "sleep" | "wake" | "reload") =>
    post<{ ok: boolean }>(`${control}/agents/${id}/${action}`),

  /**
   * How much this agent asks before running a gated tool.
   *
   * The dashboard is the **only** surface that can write this. A chat command cannot (a chat sender is
   * not authenticated) and no CLI verb does (the agent holds the `nouride` tool and could be talked
   * into loosening its own gate). Admin only, server-side.
   */
  setAgentApprovals: (id: string, approvals: "per-person" | "careful" | "balanced" | "trusted") =>
    post<{ ok: true; approvals: string }>(`${control}/agents/${id}/approvals`, { approvals }),
  /** Whether this agent's commands ask before using a credential sent in chat, after outside content. Admin only. */
  setAgentSharedTools: (id: string, on: boolean) => post<{ ok: true; on: boolean }>(`${control}/agents/${id}/shared_tools`, { on }),
  /** This agent's second look (0.8.0): `off`, a tier or a model id — or null to follow the daemon's. */
  setAgentModelGuard: (id: string, value: string | null) => post<{ ok: true; value: string | null }>(`${control}/agents/${id}/model_guard`, { value }),
};
