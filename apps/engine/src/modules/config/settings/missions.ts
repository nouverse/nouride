/**
 * `[missions]` as the dashboard's Missions page sets it (0.8.0): how many run at once, for one agent and on the box, and
 * the three limits a mission stops at to ask whether to go on.
 *
 * A person's, never an agent's: the limits are what keeps work nobody watches bounded. Read live by the missions
 * service (`boot/missions.ts` reads `config.missions` at every decision), so a save is in force at once — the slots at
 * the next start, the limits for each mission started after it, since a mission takes its limits when it starts.
 *
 * A key sent empty (`null`) is taken out of the file, which is how the page goes back to a default: written, the
 * default's value today would stop following the default tomorrow — and `max_running` unset follows the agents.
 */

import { createLogger, missionsPerAgentRefusal, type MissionsSection } from "@nouride/shared";
import { editPackFile } from "@/modules/config/config-file.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { removeTomlKey, upsertTomlTable } from "@/modules/config/edit.ts";
import { boundsOf } from "@/modules/config/schema.ts";
import { autoRunning, mostRunning } from "@/modules/missions/slots.ts";
import { editConfigFile } from "./file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings.missions");

/** Each setting by its name here and its key in the file. */
const KEYS = {
  perAgent: "per_agent",
  maxRunning: "max_running",
  limitHours: "limit_hours",
  limitTurns: "limit_turns",
  limitTokens: "limit_tokens",
} as const satisfies Record<keyof MissionsSection, string>;

type Setting = keyof typeof KEYS;
type Bounds = ReturnType<typeof boundsOf>;

/** The agents that are on, each by its own `per_agent` — its pack's, or undefined where it follows the daemon's (0.8.11). */
export type AgentSlots = readonly (number | undefined)[];

/** The bounds a setting keeps: the schema's, and for the slots on the box every agent at its own `per_agent` at once. */
function boundsFor(name: Setting, agents: AgentSlots, perAgent: number): Bounds {
  const bounds = boundsOf(`missions.${KEYS[name]}`);
  return name === "maxRunning" ? { min: bounds.min, max: mostRunning(agents.map((own) => own ?? perAgent)), integer: bounds.integer } : bounds;
}

/**
 * What the page shows, with `agents` the agents that are on: the values in force, each one's default — the box's slots
 * as many as the agents give it now — whether those slots follow the agents (`auto`), and the bounds each keeps.
 */
export function missionSettings(deps: Pick<SettingsDeps, "config">, agents: AgentSlots) {
  const missions = deps.config.missions;
  const bounds = Object.fromEntries((Object.keys(KEYS) as Setting[]).map((name) => [name, boundsFor(name, agents, missions.perAgent)]));
  return {
    ...missions,
    maxRunning: missions.maxRunning ?? autoRunning(agents.length),
    auto: missions.maxRunning === undefined,
    defaults: { ...DEFAULT_CONFIG.missions, maxRunning: autoRunning(agents.length) },
    bounds: bounds as Record<Setting, Bounds>,
  };
}

/** Why a value cannot be saved, in the words the loader would refuse it with — or null. */
function refusal(name: Setting, value: unknown, bounds: Bounds): string | null {
  const fits =
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= bounds.min &&
    (bounds.max === undefined || value <= bounds.max) &&
    (!bounds.integer || Number.isInteger(value));
  if (fits) return null;
  const range = `${bounds.integer ? "a whole number" : "a number"} from ${bounds.min}${bounds.max === undefined ? " up" : ` to ${bounds.max}`}`;
  return `[missions] ${KEYS[name]} must be ${range}, got ${JSON.stringify(value)}`;
}

/**
 * Change some of `[missions]`; `null` takes a key out, back to its default. Every value is checked before anything is
 * written: one out of bounds saves none. The slots on the box are held to the agents that are on now, at the `per_agent`
 * the same save leaves.
 */
export async function setMissionSettings(deps: SettingsDeps, params: { patch: Record<string, unknown>; agents: AgentSlots; actor?: string }): Promise<SaveResult> {
  const names = Object.keys(params.patch);
  const unknown = names.filter((name) => !(name in KEYS));
  if (unknown.length > 0) return { ok: false, error: `[missions] has no ${unknown.join(", ")}: it holds ${Object.keys(KEYS).join(", ")}` };
  if (names.length === 0) return { ok: false, error: "nothing to change: send one of perAgent, maxRunning, limitHours, limitTurns, limitTokens" };
  const next = params.patch.perAgent;
  const perAgent = typeof next === "number" ? next : next === null ? DEFAULT_CONFIG.missions.perAgent : deps.config.missions.perAgent;
  for (const name of names as Setting[]) {
    if (params.patch[name] === null) continue;
    const refused = refusal(name, params.patch[name], boundsFor(name, params.agents, perAgent));
    if (refused) return { ok: false, error: refused };
  }

  const previous = { ...deps.config.missions };
  const values = Object.fromEntries((names as Setting[]).map((name) => [KEYS[name], params.patch[name] as number | null]));
  const set = Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== null));
  const cleared = Object.keys(values).filter((key) => values[key] === null);
  const saved = await editConfigFile(deps, (source) => cleared.reduce((text, key) => removeTomlKey(text, "missions", key), upsertTomlTable(source, "missions", set)));
  if (!saved.ok) return saved;

  log.info("mission settings changed", { ...values, actor: params.actor });
  deps.audit?.record({ action: "missions_settings_changed", actor: params.actor, details: { values, previous } });
  return { ok: true, restartRequired: false };
}

/**
 * How many missions one agent may have working at once — `[missions] per_agent` in its pack — or `null` to follow the
 * daemon's (0.8.11). Live: the pack is reloaded by the write, and the dispatcher reads it at its next decision.
 */
export async function saveAgentMissionsPerAgent(deps: SettingsDeps, input: {
  agentConfigPath: string;
  /** Reloads the agent: the write is checked by it, and put back when the pack no longer loads. */
  reload: () => Promise<unknown>;
  value: number | null;
  actor: string;
  agentId: string;
}): Promise<SaveResult> {
  if (input.value !== null) {
    const refused = missionsPerAgentRefusal(input.value, "[missions] per_agent");
    if (refused) return { ok: false, error: refused };
  }
  const saved = await editPackFile({
    path: input.agentConfigPath,
    reload: input.reload,
    edit: (source) => (input.value === null ? removeTomlKey(source, "missions", "per_agent") : upsertTomlTable(source, "missions", { per_agent: input.value })),
  });
  if (!saved.ok) return saved;
  log.info("agent mission slots changed", { agent: input.agentId, per_agent: input.value, actor: input.actor });
  deps.audit?.record({ action: "agent_missions_per_agent_changed", actor: input.actor, details: { agent: input.agentId, per_agent: input.value } });
  return { ok: true, restartRequired: false };
}
