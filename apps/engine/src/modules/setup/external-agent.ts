/**
 * An external agent's CLI settings from its Brain tab (0.8.1): its profile, preset and model — `[external]` in its own
 * config.toml, written through the pack edit every other setting takes, so the loader's own reading decides what is
 * valid and a value it refuses leaves the file as it was. An empty model is the key removed: the CLI's own default.
 */

import { join } from "@nouride/runtime";
import { createLogger, type ExternalPermissions } from "@nouride/shared";
import { removeTomlKey, removeTomlTable, upsertTomlTable } from "@/modules/config/edit.ts";
import { editPackFile } from "@/modules/config/config-file.ts";
import type { SetupDeps } from "./service.ts";
import { externalOrchestratorRefusal } from "./agent-access.ts";

const log = createLogger("setup");

export interface ExternalSettings {
  profile?: string;
  permissions?: ExternalPermissions;
  model?: string;
}

/**
 * Nouride's own model for a new external agent that names none (0.8.1) — what answers a message its CLI cannot, a
 * mission's review, the memory pass: the install's default, else the orchestrator's, the model this install already
 * answers with. Null where there is neither. With no default — the live box has none — one made from the dashboard was
 * refused ("A model is required"), and one made from a chat did not load. The dashboard and `agent_create` both ask
 * this.
 */
export function externalAgentLlm(defaults: { provider: string; model: string }, orchestrator: { provider: string; model: string } | undefined): { provider?: string; model: string } | null {
  if (defaults.model.trim()) return { ...(defaults.provider.trim() ? { provider: defaults.provider.trim() } : {}), model: defaults.model.trim() };
  return orchestrator?.model ? { provider: orchestrator.provider, model: orchestrator.model } : null;
}

/** The keys an empty value removes rather than writes. */
const CLEARABLE = new Set(["model"]);

export async function setExternal(
  deps: Pick<SetupDeps, "registry" | "audit">,
  input: { agentId: string; settings: ExternalSettings; actor: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const agent = deps.registry.get(input.agentId);
  if (!agent) return { ok: false, error: `no agent "${input.agentId}"` };
  if (!agent.config.external) return { ok: false, error: `${input.agentId} is not an external agent` };
  const given = Object.entries(input.settings).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (given.length === 0) return { ok: true };
  const saved = await editPackFile({
    path: join(agent.dir, "config.toml"),
    reload: () => deps.registry.reload(input.agentId),
    edit: (source) => {
      let next = source;
      const set: Record<string, string> = {};
      for (const [key, value] of given) {
        if (!value.trim() && CLEARABLE.has(key)) next = removeTomlKey(next, "external", key);
        else set[key] = value.trim();
      }
      return Object.keys(set).length > 0 ? upsertTomlTable(next, "external", set) : next;
    },
  });
  if (!saved.ok) return saved;
  log.info("an external agent's CLI settings changed", { agent: input.agentId, keys: given.map(([key]) => key), actor: input.actor });
  deps.audit?.record({ action: "agent_external_changed", agentId: input.agentId, actor: input.actor, details: { keys: given.map(([key]) => key) } });
  return { ok: true };
}

/**
 * Whether a coding CLI answers an agent that already exists (0.8.1): `[external]` written into its pack, on a profile,
 * or taken out again — the pack edit every other setting takes, so a CLI the loader does not know leaves the file as
 * it was. A person asked for two of their agents to become Claude Code, and with no way to, the orchestrator reached
 * their packs through `nouride tools run`. The orchestrator itself is refused: Nouride's gate does not reach its CLI's
 * own commands, and anyone in a room reaches it (`externalOrchestratorRefusal`). What it keeps — its persona pack, its
 * memory, its notes — stays, and the CLI reads the pack.
 */
export async function setAnsweredBy(
  deps: Pick<SetupDeps, "registry" | "audit" | "config">,
  input: { agentId: string; cli: string | null; profile?: string; actor: string },
): Promise<{ ok: true } | { ok: false; error: string; field?: "cli" }> {
  const agent = deps.registry.get(input.agentId);
  if (!agent) return { ok: false, error: `no agent "${input.agentId}"` };
  // The choice itself refused (0.8.23): the page names it.
  if (input.cli !== null && deps.config.daemon.orchestrator === input.agentId) return { ok: false, field: "cli", error: externalOrchestratorRefusal(input.agentId) };
  if (input.cli === null && !agent.config.external) return { ok: true };
  const profile = input.profile?.trim();
  const cli = input.cli;
  // Another CLI is not asked for the model named for the one before: the key was kept, so a switch from Codex to Claude
  // Code asked Claude Code for Codex's model. Without it, the new CLI answers on its own default until one is chosen.
  const switching = agent.config.external !== undefined && cli !== null && agent.config.external.cli !== cli;
  const saved = await editPackFile({
    path: join(agent.dir, "config.toml"),
    reload: () => deps.registry.reload(input.agentId),
    edit: (source) =>
      cli === null
        ? removeTomlTable(source, "external")
        : upsertTomlTable(switching ? removeTomlKey(source, "external", "model") : source, "external", { cli, ...(profile ? { profile } : {}) }),
  });
  if (!saved.ok) return saved;
  log.info("which CLI answers an agent changed", { agent: input.agentId, cli: input.cli, actor: input.actor });
  deps.audit?.record({ action: input.cli === null ? "agent_made_internal" : "agent_made_external", agentId: input.agentId, actor: input.actor, details: input.cli === null ? {} : { cli: input.cli, profile: profile ?? "default" } });
  return { ok: true };
}
