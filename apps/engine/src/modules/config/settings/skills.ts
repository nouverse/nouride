/**
 * `[skills] off` — the pool switch that is not any one agent's.
 *
 * ## Why this is separate from the per-agent matrix
 *
 * `POST /skills/:name/agents/:agentId` writes one cell of `skills.toml`: "nero does not need this
 * one". That is the right shape for a preference and the wrong shape for a removal.
 *
 * A built-in cannot be removed. It ships inside the executable, so `DELETE /skills/:name` refuses it
 * and a deletion would be undone by the next upgrade anyway — switching it off is the only removal
 * it has. Doing that by writing `false` into every pack would not be off: it would be off for the
 * agents that existed when the button was pressed, and the next agent created would carry the skill
 * again with nothing anywhere to say why.
 *
 * ## Not restricted to built-ins
 *
 * The mechanism does not care, and a rule that it did would be one more thing to explain. A pool
 * skill somebody wants off everywhere but not deleted — kept for reference, or paused while it is
 * rewritten — is a real case. Built-ins simply *need* this; pool skills merely benefit.
 */

import { createLogger } from "@nouride/shared";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { editConfigFile } from "./file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings.skills");

export async function setSkillOffGlobally(
  deps: SettingsDeps,
  params: { name: string; off: boolean; actor?: string },
): Promise<SaveResult> {
  const { name, off } = params;
  const current = deps.config.skills.off;
  const wanted = off ? [...new Set([...current, name])].sort() : current.filter((n) => n !== name);

  if (wanted.length === current.length && wanted.every((n, i) => n === current[i])) {
    return { ok: true, restartRequired: false };
  }

  // The running list changes with the file, in the same array (`config/follow.ts`): the registry reads
  // `config.skills.off` on every pack reload, which the caller runs next.
  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "skills", { off: wanted }));
  if (!saved.ok) return saved;

  // At warn when something is switched off, matching `setSensitivePaths` and the RSI writer: an
  // operator working out why an agent stopped using a skill should not have to grep info lines.
  const detail = { skill: name, actor: params.actor, off: wanted };
  if (off) log.warn("skill switched off for every agent", detail);
  else log.info("skill switched back on for every agent", detail);

  deps.audit?.record({
    action: off ? "skill_disabled_globally" : "skill_enabled_globally",
    actor: params.actor,
    details: { skill: name, off: wanted },
  });

  return { ok: true, restartRequired: false };
}
