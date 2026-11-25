/**
 * Opening an agent to everyone, and closing it again.
 *
 * Opening is one edit of the agent's pack: `access = "open"` and the two limits on what strangers may cost it
 * (`[open]`), written together, so no file ever says open without them. It is refused for the orchestrator and for an
 * agent on a coding CLI, before anything is written (`agent-access.ts`), and for an agent with notes of its own until
 * the one opening it says they know: taking an agent's tools away takes away nothing it was told, and what its notes
 * hold it may say to anyone who asks.
 *
 * Closing sets it to follow the install, and leaves its limits in the file for the next time.
 */

import { join } from "@nouride/runtime";
import { createLogger, type OpenLimits } from "@nouride/shared";
import { editPackFile } from "@/modules/config/config-file.ts";
import { removeTomlKey, upsertTomlTable } from "@/modules/config/edit.ts";
import { openOnCliRefusal, openOrchestratorRefusal } from "./agent-access.ts";
import type { SetupDeps } from "./service.ts";

const log = createLogger("setup");

/** Whether an agent's `MEMORY.md` holds anything it wrote down: a line that is not a heading, a comment or blank. */
export function hasNotes(memory: string | undefined): boolean {
  return (memory ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .some((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

const notesFirst = (agentId: string): string =>
  `${agentId} has notes of its own, and once it is open it may say what they hold to anyone who asks. Read its notes first, then open it and say that you have.`;

export type Opened = { ok: true } | { ok: false; error: string; notes?: true };

export async function openAgent(
  deps: Pick<SetupDeps, "registry" | "audit" | "config">,
  input: { agentId: string; limits: OpenLimits; knowsItsNotes?: boolean; actor: string },
): Promise<Opened> {
  const agent = deps.registry.get(input.agentId);
  if (!agent) return { ok: false, error: `no agent "${input.agentId}"` };
  // Said before anything is written. The reload a save ends in refuses both too (the loader, and boot's `refuse`).
  if (deps.config.daemon.orchestrator === input.agentId) return { ok: false, error: openOrchestratorRefusal(input.agentId) };
  if (agent.config.external) return { ok: false, error: openOnCliRefusal(input.agentId) };
  // Asked when it is opened: saving new limits for an agent that is open already opens nothing more.
  if (agent.config.access !== "open" && hasNotes(agent.persona.memory) && input.knowsItsNotes !== true) return { ok: false, notes: true, error: notesFirst(input.agentId) };
  const { maxDailyTokens, maxDailyMessagesPerPerson } = input.limits;
  const closedReply = input.limits.closedReply?.trim();
  const saved = await editPackFile({
    path: join(agent.dir, "config.toml"),
    reload: () => deps.registry.reload(input.agentId),
    edit: (source) => {
      const numbers = { max_daily_tokens: maxDailyTokens, max_daily_messages_per_person: maxDailyMessagesPerPerson };
      const opened = upsertTomlTable(upsertTomlTable(source, "agent", { access: "open" }), "open", closedReply ? { ...numbers, closed_reply: closedReply } : numbers);
      // No sentence given: Nouride's own is said, and one written before is not kept behind the page's back.
      return closedReply ? opened : removeTomlKey(opened, "open", "closed_reply");
    },
  });
  if (!saved.ok) return saved;
  log.info("agent opened to everyone", { agent: input.agentId, max_daily_tokens: maxDailyTokens, max_daily_messages_per_person: maxDailyMessagesPerPerson, actor: input.actor });
  deps.audit?.record({ action: "agent_opened", agentId: input.agentId, actor: input.actor, details: { maxDailyTokens, maxDailyMessagesPerPerson } });
  return { ok: true };
}

export async function closeAgent(deps: Pick<SetupDeps, "registry" | "audit">, input: { agentId: string; actor: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const agent = deps.registry.get(input.agentId);
  if (!agent) return { ok: false, error: `no agent "${input.agentId}"` };
  if (agent.config.access !== "open") return { ok: true };
  const saved = await editPackFile({
    path: join(agent.dir, "config.toml"),
    reload: () => deps.registry.reload(input.agentId),
    edit: (source) => upsertTomlTable(source, "agent", { access: "follow" }),
  });
  if (!saved.ok) return saved;
  log.info("agent closed to strangers", { agent: input.agentId, actor: input.actor });
  deps.audit?.record({ action: "agent_closed", agentId: input.agentId, actor: input.actor, details: {} });
  return { ok: true };
}
