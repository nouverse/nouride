/**
 * The Limits form's decisions, apart from drawing it (0.8.0): what each field shows, and what a save sends. Pure, so
 * each is tested on its own (`tests/missions-lib.test.ts`).
 *
 * A field at its default is left empty, the default showing in grey, so what a person changed stands out; emptying a
 * field sends `null`, which takes its key out of the file — written, today's default would stop following the default.
 * The slots on the box are at their default only while they follow the agents: the same number set by hand is set.
 * Tokens are typed in millions — 50, not 50000000, which nobody reads at a glance — and sent as tokens.
 */

import type { MissionLimits, MissionSettings, MissionSettingsPatch } from "@/commons/lib/api";

export type LimitKey = keyof MissionLimits;
type Bounds = MissionSettings["bounds"][LimitKey];

/** How many of a setting one unit of its field is. */
const SCALE: Partial<Record<LimitKey, number>> = { limitTokens: 1_000_000 };

/** A setting as its field shows it: tokens in millions. */
export function shown(key: LimitKey, value: number): number {
  return value / (SCALE[key] ?? 1);
}

/** Whether a setting is at its default: the slots on the box while they follow the agents, the rest at the default's value. */
function atDefault(settings: MissionSettings, key: LimitKey): boolean {
  return key === "maxRunning" ? settings.auto : settings[key] === settings.defaults[key];
}

/** What a field holds before anyone types: empty at the default, the value otherwise. */
export function fieldText(settings: MissionSettings, key: LimitKey): string {
  return atDefault(settings, key) ? "" : String(shown(key, settings[key]));
}

/** Whether a value fits its bounds — the same test the daemon applies. */
export function fits(value: number, bounds: Bounds): boolean {
  return Number.isFinite(value) && value >= bounds.min && (bounds.max === undefined || value <= bounds.max) && (!bounds.integer || Number.isInteger(value));
}

/** `1–4`, `0.25–168, fractions allowed`, `0.1M or more` — in the field's units. */
export function range(key: LimitKey, bounds: Bounds): string {
  const unit = (n: number) => `${shown(key, n)}${SCALE[key] ? "M" : ""}`;
  return `${unit(bounds.min)}${bounds.max === undefined ? " or more" : `–${unit(bounds.max)}`}${bounds.integer || SCALE[key] ? "" : ", fractions allowed"}`;
}

/**
 * The save, from what was typed: each field whose text is not what it held — its value as the daemon reads it, or `null`
 * for one emptied — and the fields whose value does not fit, which keep the save from being sent.
 */
export function limitsPatch(settings: MissionSettings, draft: Partial<Record<LimitKey, string>>): { patch: MissionSettingsPatch; bad: LimitKey[] } {
  const patch: MissionSettingsPatch = {};
  const bad: LimitKey[] = [];
  for (const [key, typed] of Object.entries(draft) as [LimitKey, string][]) {
    const text = typed.trim();
    if (text === fieldText(settings, key)) continue;
    if (text === "") {
      patch[key] = null;
      continue;
    }
    const scale = SCALE[key];
    const value = scale ? Math.round(Number(text) * scale) : Number(text);
    if (fits(value, settings.bounds[key])) patch[key] = value;
    else bad.push(key);
  }
  return { patch, bad };
}
