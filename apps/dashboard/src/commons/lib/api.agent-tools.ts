/**
 * What a new agent starts as, and an existing one's tools and default — `routes/agent-tools.ts`.
 */

import { control, post, request } from "./api.client";
import type { AgentDeleted, AgentDeletion, AgentPresets, AgentPublic } from "@nouride/wire";

export const agentToolsApi = {
  agentPresets: () => request<AgentPresets>(`${control}/setup/presets`),
  /** Operator: what this agent is for, said to its peers — the `Headline:` line of its IDENTITY.md. */
  setAgentHeadline: (id: string, headline: string) => post<{ ok: true; headline: string }>(`${control}/agents/${id}/headline`, { headline }),
  /** Admin only: a tool switched on is a capability granted. */
  setAgentTools: (id: string, tools: string[]) => post<{ ok: true }>(`${control}/agents/${id}/tools`, { tools }),
  /** Admin only: whether this agent's connections take new senders, or follow the daemon. */
  setAgentAccess: (id: string, access: "follow" | "pair" | "allowlist") => post<{ ok: true }>(`${control}/agents/${id}/access`, { access }),
  /** Admin only: open an agent to everyone, with the two limits on what strangers may cost it; `knowsItsNotes` where it has notes. */
  openAgent: (id: string, body: { maxDailyTokens: number; maxDailyMessagesPerPerson: number; closedReply?: string; knowsItsNotes?: boolean }) => post<{ ok: true }>(`${control}/agents/${id}/open`, body),
  /** Admin only: an open agent's conversations with the public, newest first; `before` is the last page's cursor. */
  agentPublic: (id: string, before?: number) => request<AgentPublic>(`${control}/agents/${id}/public${before ? `?before=${before}` : ""}`),
  /** Operator and up: close an agent that is open to everyone. Its limits are kept for the next time. */
  closeAgent: (id: string) => post<{ ok: true }>(`${control}/agents/${id}/close`, {}),
  /** Admin: the agent that answers when nobody is named, and the front desk of rooms. */
  setOrchestrator: (id: string) => post<{ ok: true }>(`${control}/agents/${id}/orchestrator`, {}),
  /** Admin: what deleting this agent would take, counted for the question that asks. Refused for the orchestrator. */
  agentDeletion: (id: string) => request<AgentDeletion>(`${control}/agents/${id}/delete`),
  /** Admin: the agent deleted. `confirm` is its id, typed again by the person. */
  deleteAgent: (id: string, confirm: string) => post<AgentDeleted>(`${control}/agents/${id}/delete`, { confirm }),
};
