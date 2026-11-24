/**
 * What the dashboard changes about an agent after it exists: which tools it has, whether it takes new
 * senders, and whether it is the orchestrator.
 *
 * Tools are `[tools] enabled` in the agent's own `config.toml`, the same line a preset wrote when it
 * was created — so a switch on the dashboard and an edit in the file editor are one mechanism. The
 * orchestrator is `daemon.orchestrator`: the agent a message reaches when nothing
 * names another, a room's front desk, and the one listed first. Both are written to the file and then applied, so a restart keeps them.
 */

import { join } from "@nouride/runtime";
import { createLogger, type AgentAccess } from "@nouride/shared";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { editDaemonConfig, editPackFile } from "@/modules/config/config-file.ts";
import type { SetupDeps } from "./service.ts";

const log = createLogger("setup");

type Result = { ok: true } | { ok: false; error: string };

export async function setAgentTools(
  deps: Pick<SetupDeps, "registry" | "audit">,
  input: { agentId: string; tools: readonly string[]; available: readonly string[]; actor: string },
): Promise<Result> {
  const agent = deps.registry.get(input.agentId);
  if (!agent) return { ok: false, error: `no agent "${input.agentId}"` };
  const unknown = input.tools.filter((name) => !input.available.includes(name));
  if (unknown.length) return { ok: false, error: `no such tool on this daemon: ${unknown.join(", ")}` };

  // In the daemon's order whatever order the switches were clicked in, so the file does not churn.
  const tools = input.available.filter((name) => input.tools.includes(name));
  // An agent on `"*"` stays on it while every switch is on — saving from the page must not freeze it to
  // this release's list. One switch off, and it is the list.
  const every = agent.config.tools.everyTool === true && input.available.every((name) => tools.includes(name));
  const saved = await editPackFile({
    path: join(agent.dir, "config.toml"),
    reload: () => deps.registry.reload(input.agentId),
    edit: (source) => upsertTomlTable(source, "tools", { enabled: every ? ["*"] : tools }),
  });
  if (!saved.ok) return saved;
  log.info("agent tools changed", { agent: input.agentId, tools, actor: input.actor });
  deps.audit?.record({ action: "agent_tools_changed", agentId: input.agentId, actor: input.actor, details: { tools } });
  return { ok: true };
}

/** `[daemon] orchestrator` set. */
export function namingOrchestrator(source: string, agentId: string): string {
  return upsertTomlTable(source, "daemon", { orchestrator: agentId });
}

/**
 * An external agent is never the orchestrator: Nouride's approval level, fixed list and tool switches
 * do not reach its coding CLI's own commands, and the orchestrator is the agent anyone in a room reaches. It answers in its
 * own channel, in a room when addressed, and to `ask_agent`. It said the CLI "cannot route, delegate or keep the household's
 * memory" until 0.8.10 — untrue since 0.8.1 lent it `ask_agent`, `delegate` and the memory tools.
 */
export function externalOrchestratorRefusal(agentId: string): string {
  return `${agentId} is an external agent: Nouride's approval level, fixed list and tool switches do not reach its coding CLI's own commands, and the orchestrator is the agent anyone in a room reaches. Make a Nouride agent the orchestrator, and hand work to ${agentId} with ask_agent.`;
}

/**
 * The orchestrator is never open to everyone, whichever is asked for second: it is the agent that holds the install,
 * and what it knows of the household is in what its model reads, whatever tools it is left with.
 */
export function openOrchestratorRefusal(agentId: string): string {
  return `${agentId} is the orchestrator, the agent that holds this install, so it is never open to everyone. Make another agent for the public and open that one.`;
}

function orchestratorOpenRefusal(agentId: string): string {
  return `${agentId} is open to everyone, so it cannot be the orchestrator, the agent that holds this install. Close it first, or make another agent the orchestrator.`;
}

/**
 * Nor is an agent on a coding CLI, whichever is asked for second: what makes an open agent safe is that the daemon
 * decides its tools, and a CLI brings its own.
 */
function openOnCliRefusal(agentId: string): string {
  return `${agentId} works through a coding CLI, which brings tools of its own that Nouride cannot take away, so it is never open to everyone. Open an agent that answers on a model instead.`;
}

export function cliOnOpenRefusal(agentId: string): string {
  return `${agentId} is open to everyone, so it cannot work through a coding CLI, which brings tools of its own that Nouride cannot take away. Close it first.`;
}

export async function setOrchestrator(
  deps: Pick<SetupDeps, "registry" | "audit" | "config" | "configPath">,
  input: { agentId: string; actor: string },
): Promise<Result> {
  const agent = deps.registry.get(input.agentId);
  if (!agent) return { ok: false, error: `no agent "${input.agentId}"` };
  if (agent.config.external) return { ok: false, error: externalOrchestratorRefusal(input.agentId) };
  if (agent.config.access === "open") return { ok: false, error: orchestratorOpenRefusal(input.agentId) };
  const saved = await editDaemonConfig(deps.configPath, deps.config, (source) => namingOrchestrator(source, input.agentId));
  if (!saved.ok) return saved;
  log.info("orchestrator changed", { agent: input.agentId, actor: input.actor });
  deps.audit?.record({ action: "orchestrator_changed", agentId: input.agentId, actor: input.actor, details: {} });
  return { ok: true };
}

/**
 * Whether this agent's connections pair a stranger or drop them, or follow the daemon — `[agent]
 * access` in its own config.toml. `follow` is written rather than the key removed, the way `approvals`
 * writes `per-person`: the file then says it follows, instead of saying nothing.
 */
export async function setAgentAccess(
  deps: Pick<SetupDeps, "registry" | "audit" | "config">,
  input: { agentId: string; access: AgentAccess; actor: string },
): Promise<Result> {
  const agent = deps.registry.get(input.agentId);
  if (!agent) return { ok: false, error: `no agent "${input.agentId}"` };
  // Said before anything is written. The reload a save ends in refuses both too (the loader, and boot's `refuse`).
  if (input.access === "open" && deps.config.daemon.orchestrator === input.agentId) return { ok: false, error: openOrchestratorRefusal(input.agentId) };
  if (input.access === "open" && agent.config.external) return { ok: false, error: openOnCliRefusal(input.agentId) };
  const saved = await editPackFile({
    path: join(agent.dir, "config.toml"),
    reload: () => deps.registry.reload(input.agentId),
    edit: (source) => upsertTomlTable(source, "agent", { access: input.access }),
  });
  if (!saved.ok) return saved;
  log.info("agent sender access changed", { agent: input.agentId, access: input.access, actor: input.actor });
  deps.audit?.record({ action: "agent_access_changed", agentId: input.agentId, actor: input.actor, details: { access: input.access } });
  return { ok: true };
}
