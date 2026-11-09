import type { AgentSummary } from "@nouride/wire";

/**
 * The orchestrator first, the rest as the daemon listed them — on every page that lists agents, so
 * the one that answers when nobody is named is always where a person looks first.
 */
export function orchestratorFirst<T extends { id: string }>(agents: readonly T[], orchestrator: string | null | undefined): T[] {
  return [...agents].sort((a, b) => Number(b.id === orchestrator) - Number(a.id === orchestrator));
}

/** What an agent is doing, in a few words, and the dot's colour for it: Home's chips and a chat's header say the same. */
export function doingNow(agent: AgentSummary): { words: string; tone: "success" | "accent" | "muted" } {
  if (!agent.enabled || agent.state !== "running") return { words: agent.enabled ? "Not running" : "Switched off", tone: "muted" };
  const activity = agent.activity;
  if (!activity) return { words: "Ready", tone: "success" };
  if (activity.unavailable) return { words: activity.unavailable, tone: "muted" };
  if (activity.activity === "waiting") return { words: "Waiting for you", tone: "accent" };
  const missions = activity.missions ?? 0;
  if (missions > 0) return { words: missions === 1 ? "1 mission running" : `${missions} missions running`, tone: "success" };
  if (activity.activity === "working") return { words: "Working", tone: "success" };
  if (activity.activity === "asleep") return { words: "Asleep", tone: "muted" };
  return { words: "Idle", tone: "muted" };
}

/**
 * The model an agent answers with, as lists show it. An external agent's is its CLI's — the pack's, or the CLI's own
 * default, named once a session has said it: "Claude Code · Opus 5.5 (default)". Its `model` is its `[llm]`, which
 * answers none of its turns, and the agent picker showed that as the agent's (0.8.1).
 */
export function agentModel(agent: Pick<AgentSummary, "model" | "external">): string {
  const external = agent.external;
  if (!external) return agent.model;
  const model = external.model || (external.cliDefault ? `${external.cliDefault} (default)` : "its default model");
  return `${external.name ?? external.cli} · ${model}`;
}
