/**
 * An agent's effort (0.8.7): `[llm] effort` in its own config.toml — how long its model thinks, and its coding CLI's
 * where the CLI offers that level (`external-agents/connection.ts` `settle`). Set by the agent on a person's word
 * (`agent_configure`) or from its CLI tab. Before, it was a line in a file nobody but an admin on the box could edit:
 * asked to think harder, the agent could only say it had no way to.
 *
 * "default" takes the agent's own away, so it follows the install's `[llm.defaults] effort`, else the provider's.
 */

import { join } from "@nouride/runtime";
import { createLogger, LLM_EFFORTS } from "@nouride/shared";
import { editPackFile } from "@/modules/config/config-file.ts";
import { removeTomlKey, upsertTomlTable } from "@/modules/config/edit.ts";
import type { SetupDeps } from "./service.ts";

const log = createLogger("setup");

/** What an agent's effort can be set to: a level, or back to the install's. */
export const EFFORT_CHOICES = [...LLM_EFFORTS, "default"] as const;

export function isEffortChoice(value: unknown): value is (typeof EFFORT_CHOICES)[number] {
  return typeof value === "string" && (EFFORT_CHOICES as readonly string[]).includes(value);
}

/** A pack's text with its `[llm] effort` set — or taken away, for "default". */
export function withEffort(source: string, effort: (typeof EFFORT_CHOICES)[number]): string {
  return effort === "default" ? removeTomlKey(source, "llm", "effort") : upsertTomlTable(source, "llm", { effort });
}

export async function setEffort(
  deps: Pick<SetupDeps, "registry" | "audit">,
  input: { agentId: string; effort: string; actor: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const agent = deps.registry.get(input.agentId);
  if (!agent) return { ok: false, error: `no agent "${input.agentId}"` };
  const effort = input.effort;
  if (!isEffortChoice(effort)) return { ok: false, error: `effort is one of ${EFFORT_CHOICES.join(", ")}` };
  const saved = await editPackFile({ path: join(agent.dir, "config.toml"), reload: () => deps.registry.reload(input.agentId), edit: (source) => withEffort(source, effort) });
  if (!saved.ok) return saved;
  log.info("an agent's effort changed", { agent: input.agentId, effort, actor: input.actor });
  deps.audit?.record({ action: "agent_effort_changed", agentId: input.agentId, actor: input.actor, details: { effort } });
  return { ok: true };
}
