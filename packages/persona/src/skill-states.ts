/**
 * `agents/<id>/skills.toml` — which skills this agent has switched off.
 *
 * ```toml
 * # Every skill in agents/skills/ is on. List one here to switch it off for this agent.
 * [skills]
 * document-authoring = false
 * k8s-ingress-debug = true          # explicit, so the dashboard shows it was reviewed
 * ```
 *
 * **Its own file, not a `[skills]` table in `config.toml`.** Three things write here — an operator in
 * the Skills Workshop, an agent calling `skill_toggle`, and a hand edit — while `config.toml` decides
 * whether the pack loads at all. Keeping them apart means a botched toggle write costs a skill, not a
 * booting agent, and `git log agents/nouva/skills.toml` answers "when did it stop knowing that?".
 *
 * A missing file is the normal state and means every skill is on, which is why nothing here creates
 * one: an agent that has never switched anything off should have no file to read.
 */

import { ConfigError } from "@nouride/shared";

/** The toggle file's name inside an agent pack. */
export const SKILL_STATES_FILE = "skills.toml";

export interface RawSkillStates {
  skills?: unknown;
}

/**
 * Parse the `[skills]` table into a name → on/off map.
 *
 * Strict about the value type. `document-authoring = "off"` is exactly the mistake someone makes
 * once, and a parser that shrugged at it would leave a skill switched on while the file says
 * otherwise — the silent-setting class of bug this codebase keeps finding. `where` names the file so
 * the message points at the line to fix (invariant 7).
 */
export function parseSkillStates(raw: RawSkillStates | null, where: string): Record<string, boolean> {
  if (!raw || raw.skills === undefined) return {};
  if (typeof raw.skills !== "object" || raw.skills === null || Array.isArray(raw.skills)) {
    throw new ConfigError(`${where} [skills] must be a table of "skill-name = true|false"`);
  }

  const states: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(raw.skills as Record<string, unknown>)) {
    if (typeof value !== "boolean") {
      throw new ConfigError(
        `${where} [skills] ${name} must be true or false, not ${JSON.stringify(value)}`,
      );
    }
    states[name] = value;
  }
  return states;
}

/**
 * Serialise a state map back to a whole `skills.toml`.
 *
 * A full rewrite rather than the surgical `upsertTomlTable` used for `config.toml`, and the reason is
 * the same one that gave this file its own name: it holds one generated table and no operator prose,
 * so there is nothing to preserve — while a config full of comments must never be rewritten wholesale.
 *
 * Only the `false` entries and the explicit `true` ones are written, sorted, so the file stays a
 * readable record of decisions instead of growing a line for every skill that ever existed.
 */
export function renderSkillStates(states: Record<string, boolean>): string {
  const entries = Object.entries(states).sort(([a], [b]) => a.localeCompare(b));

  const lines = [
    "# Skills this agent has an opinion about. Everything in agents/skills/ is ON by default;",
    "# a skill listed here as false is switched off for this agent only.",
    "#",
    "# Edited by the Skills Workshop in the dashboard and by the agent's own `skill_toggle` tool.",
    "[skills]",
    ...entries.map(([name, on]) => `${tomlKey(name)} = ${on ? "true" : "false"}`),
    "",
  ];
  return lines.join("\n");
}

/**
 * A skill name as a TOML key.
 *
 * Bare where the name allows it — `[a-z0-9-_]`, which every name `skill_create` accepts already is —
 * and quoted otherwise, because a name that arrived from a hand-written directory can hold a dot and
 * a bare `a.b` is a *nested table* in TOML rather than a key with a dot in it.
 */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}
