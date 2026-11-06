/**
 * Skill learning's three settings (`[skills.learning]`), changed from the dashboard instead of from `config.toml`.
 *
 * **Live**: `ReflectionEngine` is handed `config.skills.learning` by reference and reads it when a turn finishes, and a
 * save changes the object in place (`config/follow.ts`), so the save *is* the change and nothing reports a restart.
 *
 * Until 0.7.27 this was `[rsi]` with five tuning dials beside them — numbers an operator had to understand before they
 * could leave them alone. They are the pass's own now (`reflection/tuning.ts`).
 */

import { createLogger, type SkillLearningMode, type SkillLearningSection } from "@nouride/shared";
import { CONFIG_ENUMS } from "@/modules/config/schema.ts";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { editConfigFile } from "./file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings");

export type LearningPatch = Partial<SkillLearningSection>;

/**
 * Apply a patch; absent fields are left alone. Validated whole before anything is written, so a half-valid patch
 * changes nothing.
 */
export async function setSkillLearning(deps: SettingsDeps, params: { patch: LearningPatch; actor?: string }): Promise<SaveResult> {
  const { patch } = params;
  const current = deps.config.skills.learning;

  const error = validate(patch);
  if (error) return { ok: false, error };

  const next: SkillLearningSection = {
    mode: patch.mode ?? current.mode,
    model: patch.model === undefined ? current.model : patch.model.trim(),
    notifyChat: patch.notifyChat ?? current.notifyChat,
  };
  const changed = (Object.keys(next) as (keyof SkillLearningSection)[]).filter((key) => next[key] !== current[key]);
  if (changed.length === 0) return { ok: true, restartRequired: false };

  // The whole table, not only what changed: the file states the configuration in force.
  const saved = await editConfigFile(deps, (source) =>
    upsertTomlTable(source, "skills.learning", { mode: next.mode, model: next.model, notify_chat: next.notifyChat }),
  );
  if (!saved.ok) return saved;

  // At warn for either end: switched off is what somebody finding out why the agents went quiet needs, and `auto` is
  // the moment the pool stopped needing a person.
  const detail = { changed, actor: params.actor, ...next };
  if (changed.includes("mode") && next.mode === "off") log.warn("skill learning switched off", detail);
  else if (changed.includes("mode") && next.mode === "auto") log.warn("skill learning now writes to the pool unattended", detail);
  else log.info("skill learning settings changed", detail);
  deps.audit?.record({ action: "skill_learning_changed", actor: params.actor, details: { changed, ...next } });
  return { ok: true, restartRequired: false };
}

function validate(patch: LearningPatch): string | null {
  const modes: readonly string[] = CONFIG_ENUMS["skills.learning.mode"];
  if (patch.notifyChat !== undefined && typeof patch.notifyChat !== "boolean") return "notifyChat must be true or false";
  // Refused here, unlike at load: the loader reads an unknown mode as `ask` so a file it accepted yesterday still
  // starts; a save is a person choosing now, and telling them it did not take beats the loop quietly doing otherwise.
  if (patch.mode !== undefined && !modes.includes(patch.mode)) return `mode must be one of ${modes.join(", ")}`;
  if (patch.model !== undefined && typeof patch.model !== "string") return "model must be a string (empty means the agent's own model)";
  return null;
}

export type { SkillLearningMode };
