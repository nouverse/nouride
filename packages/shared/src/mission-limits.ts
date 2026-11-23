/**
 * A mission's three limits, each where it stops to ask a person whether to go on: the bounds they keep and why a value
 * is refused. Apart from the config's types, since two things are held to them: the settings (`[missions] limit_hours`,
 * `limit_turns`, `limit_tokens`) and one mission's own, given at its draft.
 */

/**
 * The bounds each of a mission's three limits keeps: the settings' (`[missions] limit_hours`, `limit_turns`,
 * `limit_tokens`) and one mission's own, given at its draft. One table, so a draft cannot hold what the settings refuse.
 */
export const MISSION_LIMIT_BOUNDS = {
  hours: { min: 0.25, max: 168, fraction: true },
  turns: { min: 1, max: 1000 },
  tokens: { min: 100_000 },
} as const satisfies Record<string, { min: number; max?: number; fraction?: boolean }>;

/** Which of a mission's limits: its hours of work, its turns, its tokens. */
export type MissionLimitKey = keyof typeof MISSION_LIMIT_BOUNDS;

/**
 * Why a mission's own limit cannot be this, in words its writer can act on, or null. Tokens are written whole: a model
 * that means 250 million and writes 250 is told so, not given a mission that stops at its first turn.
 */
export function missionLimitRefusal(key: MissionLimitKey, value: unknown, where: string): string | null {
  const bounds: { min: number; max?: number; fraction?: boolean } = MISSION_LIMIT_BOUNDS[key];
  const whole = bounds.fraction !== true;
  const fits = typeof value === "number" && Number.isFinite(value) && value >= bounds.min && (bounds.max === undefined || value <= bounds.max) && (!whole || Number.isInteger(value));
  if (fits) return null;
  const range = `${whole ? "a whole number" : "a number"} from ${bounds.min}${bounds.max === undefined ? " up" : ` to ${bounds.max}`}`;
  const unit = key === "tokens" ? " It is in tokens, written whole: 250 million is 250000000." : key === "hours" ? " It is in hours of work: 12, or 0.5 for half an hour." : "";
  return `${where} must be ${range}, got ${JSON.stringify(value)}.${unit}`;
}
