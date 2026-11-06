/**
 * What a new agent starts as, and an existing one's tools and default — `routes/agent-tools.ts`.
 */

import { control, post, request } from "./api.client";

export type PresetId = "pilot" | "researcher" | "assistant" | "developer" | "custom";

export interface AgentPresetView {
  id: PresetId;
  label: string;
  summary: string;
  /** The headline an agent made from it starts with, when none is written. Absent from a daemon before 0.7.18. */
  headline?: string;
  /** The SOUL.md an agent made from it starts with — filled into the form, editable. Absent from a daemon before 0.8.1. */
  soul?: string;
  /** What it would give on this daemon. Empty for `custom`. */
  tools: string[];
}

export interface AgentPresets {
  presets: AgentPresetView[];
  /** Every tool this daemon has, grouped for the switches. */
  groups: { label: string; tools: string[] }[];
}

export const agentToolsApi = {
  agentPresets: () => request<AgentPresets>(`${control}/setup/presets`),
  /** Operator: what this agent is for, said to its peers — the `Headline:` line of its IDENTITY.md. */
  setAgentHeadline: (id: string, headline: string) => post<{ ok: true; headline: string }>(`${control}/agents/${id}/headline`, { headline }),
  /** Admin only: a tool switched on is a capability granted. */
  setAgentTools: (id: string, tools: string[]) => post<{ ok: true }>(`${control}/agents/${id}/tools`, { tools }),
  /** Admin only: whether this agent's connections take new senders, or follow the daemon. */
  setAgentAccess: (id: string, access: "follow" | "pair" | "allowlist") => post<{ ok: true }>(`${control}/agents/${id}/access`, { access }),
  /** Admin: the agent that answers when nobody is named, and the front desk of rooms. */
  setOrchestrator: (id: string) => post<{ ok: true }>(`${control}/agents/${id}/orchestrator`, {}),
};
