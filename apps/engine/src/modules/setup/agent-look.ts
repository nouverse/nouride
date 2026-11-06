/**
 * An agent's look in Nouride Office from its Look tab (0.8.1): `[look]` in its own config.toml, written through the pack
 * edit every setting takes, read back by the loader. A part given as empty is the key removed — back to the hash of the
 * agent's id; one that is not a word of its part is refused before anything is written.
 */

import { join } from "@nouride/runtime";
import { createLogger, LOOK_PARTS, type AgentLook } from "@nouride/shared";
import { removeTomlKey, upsertTomlTable } from "@/modules/config/edit.ts";
import { editPackFile } from "@/modules/config/config-file.ts";
import type { SetupDeps } from "./service.ts";

const log = createLogger("setup");

/** Each part as the Look tab sends it: a word of the part, or empty for the hash's. Parts left out stay as they are. */
export type LookChange = Partial<Record<keyof AgentLook, string>>;

export async function setLook(
  deps: Pick<SetupDeps, "registry" | "audit">,
  input: { agentId: string; look: LookChange; actor: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const agent = deps.registry.get(input.agentId);
  if (!agent) return { ok: false, error: `no agent "${input.agentId}"` };
  const given = Object.entries(input.look).filter((entry): entry is [keyof AgentLook, string] => entry[0] in LOOK_PARTS && typeof entry[1] === "string");
  for (const [part, value] of given) {
    const { key, values } = LOOK_PARTS[part];
    if (value && !(values as readonly string[]).includes(value)) return { ok: false, error: `${key} must be one of ${values.join(", ")}, or empty for its own` };
  }
  if (given.length === 0) return { ok: true };
  const saved = await editPackFile({
    path: join(agent.dir, "config.toml"),
    reload: () => deps.registry.reload(input.agentId),
    edit: (source) => {
      let next = source;
      const set: Record<string, string> = {};
      for (const [part, value] of given) {
        if (value) set[LOOK_PARTS[part].key] = value;
        else next = removeTomlKey(next, "look", LOOK_PARTS[part].key);
      }
      return Object.keys(set).length > 0 ? upsertTomlTable(next, "look", set) : next;
    },
  });
  if (!saved.ok) return saved;
  log.info("an agent's look changed", { agent: input.agentId, parts: given.map(([part]) => part), actor: input.actor });
  deps.audit?.record({ action: "agent_look_changed", agentId: input.agentId, actor: input.actor, details: Object.fromEntries(given) });
  return { ok: true };
}
