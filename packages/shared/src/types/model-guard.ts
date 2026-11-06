/**
 * `[security] model_guard` — the second look's setting (0.8.0, SMART_AUTOMATION §2.1), in the daemon's config and a
 * pack's. Loaded into one of three shapes, so nothing reads the string:
 *
 * - unset: **by the approval level** — on at `careful` and `balanced`, on the agent's `high` tier; off at `trusted`;
 * - `"off"`: off at every level;
 * - a tier (`"small"`, `"default"`, `"high"`) or a model id: on at every level, `trusted` too, on that model.
 *
 * Not the empty string for off: empty already means "the default" in this config, and a field emptied on the
 * dashboard must not switch a guard off.
 */

import { isModelTier } from "./tiers.ts";

export type ModelGuard = { by: "level" } | { off: true } | { model: string };

export function modelGuardOf(setting: string | undefined): ModelGuard {
  const said = setting?.trim() ?? "";
  if (!said) return { by: "level" };
  if (said === "off") return { off: true };
  return { model: said };
}

/** Why a value is none of the three, or null — said where the file is read, naming it and the key. */
export function modelGuardRefusal(setting: unknown): string | null {
  if (setting === undefined || setting === "") return null;
  if (typeof setting !== "string") return "takes a string: off, a tier (small, default, high) or a model id";
  const said = setting.trim();
  if (!said) return "is blank: leave it out for the approval level to decide";
  // Words that read as a switch name no model: refused rather than sent to a provider as a model id hours later.
  if (["on", "true", "yes", "no", "false", "none"].includes(said.toLowerCase())) {
    return `= "${said}" is none of off, a tier (small, default, high) or a model id: leave it out for the approval level to decide`;
  }
  if (said !== "off" && !isModelTier(said) && /\s/.test(said)) return `= "${said}" is not a model id: one has no spaces`;
  return null;
}
