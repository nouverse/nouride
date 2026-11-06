/**
 * Skill discovery — a skill is a directory holding a `SKILL.md`.
 *
 * Only the frontmatter is read at load time. The body stays on disk and is loaded when
 * a task actually matches, because a dozen skills inlined into every system prompt is
 * how a context window fills up with instructions nobody needed this turn (§6.3 SPEC).
 *
 * **One pool, switched per agent.** Every skill in a directory is offered to every agent unless
 * that agent's `skills.toml` says otherwise — see `AgentConfig.skills` for why the default is on
 * and why the state is a map rather than a list. Discovery therefore takes no allow list: it reads
 * what is on disk and asks `states` about each name.
 */

import { join, listDir, readTextFileIfExists, statFile } from "@nouride/runtime";
import type { Skill } from "@nouride/shared";

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/** A skill on disk plus this agent's answer about it. `enabled: false` skills are never prompted. */
export interface SkillState extends Skill {
  enabled: boolean;
  /** True when the agent's `skills.toml` names it explicitly, either way. */
  decided: boolean;
}

/**
 * Minimal `key: value` frontmatter parser.
 *
 * Not YAML — a dependency for two fields is not worth its supply chain (TD-014).
 * Quotes are stripped and everything else is taken literally, so a value containing a
 * colon survives.
 */
export function parseFrontmatter(source: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { fields: {}, body: source };

  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1");
    if (key) fields[key] = value;
  }

  return { fields, body: source.slice(match[0].length) };
}

/**
 * Is this skill on for an agent holding `states`?
 *
 * The agent's own `skills.toml` answer when it gives one; otherwise on, unless the skill names its `agents:` and this
 * one is not among them. The one place that decides it, so the dashboard, the prompt and the toggle tool cannot drift
 * on what an empty file means. Without `agent` — the pool as it is, nobody's — only `states` counts.
 */
export function skillEnabled(states: Record<string, boolean>, skill: Pick<Skill, "name" | "agents">, agent?: string): boolean {
  if (skill.name in states) return states[skill.name] !== false;
  return agent === undefined || skill.agents === undefined || skill.agents.includes(agent);
}

/**
 * Every skill in `skillsDir`, whether it is switched on or not.
 *
 * The listing the Skills Workshop and `skill_toggle` need: you cannot switch on a skill you cannot
 * see, and the prompt deliberately shows only what is already on. Sorted by name so two callers
 * render the same order.
 */
export async function listSkills(
  skillsDir: string,
  scope: Skill["scope"],
  states: Record<string, boolean>,
  agent?: string,
): Promise<SkillState[]> {
  const names = listDir(skillsDir)
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort();

  return (await readSkills(skillsDir, names, scope)).map((skill) => ({
    ...skill,
    enabled: skillEnabled(states, skill, agent),
    decided: skill.name in states,
  }));
}

/** A skill an agent can see, and whether `[skills] off` takes it from every agent whatever their own switch says. */
export interface PoolSkill extends SkillState {
  offGlobally: boolean;
}

/**
 * The skills one agent can see: the shared pool, then what ships built in — one entry per name, with this agent's
 * switch and the operator's global off on each.
 *
 * The one place the two rules live. A pool skill overrides a built-in of the same name ("copy it into the pool and
 * edit"), so the built-in is not listed at all; and a name in `[skills] off` is off for everybody — `offGlobally` —
 * however `enabled` (this agent's own answer) reads. It was decided in five places: the prompt applied both rules, the
 * Workshop and the reflection pass each de-duplicated their own way, and an agent's Skills tab and its own
 * `skill_toggle` listing applied neither — a globally-off skill showed as on, an overridden built-in twice.
 *
 * What reaches the prompt is `enabled && !offGlobally`.
 */
export async function agentSkillPool(options: {
  /** `agents/skills/` — `skillsDirFor(agentsDir)`. */
  poolDir: string;
  builtinDir?: string | undefined;
  /** The agent's `skills.toml`; `{}` for the pool as it is, with nobody's switch on it. */
  states: Record<string, boolean>;
  offGlobally?: readonly string[];
  /** Whose pool this is: a skill naming other `agents:` is off for this one unless its `skills.toml` says otherwise. */
  agent?: string;
}): Promise<PoolSkill[]> {
  const [shared, builtin] = await Promise.all([
    listSkills(options.poolDir, "shared", options.states, options.agent),
    options.builtinDir ? listSkills(options.builtinDir, "builtin", options.states, options.agent) : Promise.resolve([]),
  ]);
  const off = new Set(options.offGlobally ?? []);
  const seen = new Set<string>();
  return [...shared, ...builtin].flatMap((skill) => {
    if (seen.has(skill.name)) return [];
    seen.add(skill.name);
    return [{ ...skill, offGlobally: off.has(skill.name) }];
  });
}

/**
 * Read `SKILL.md` for each named directory, skipping any that has none.
 *
 * A directory without a `SKILL.md` is not a skill and not a failure either — `references/` and
 * `templates/` sit beside skills in the same tree, and a skill that bundles files is the normal
 * case rather than the exception.
 */
async function readSkills(
  skillsDir: string,
  names: string[],
  scope: Skill["scope"],
): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const name of names) {
    const path = join(skillsDir, name, "SKILL.md");
    const source = await readTextFileIfExists(path);
    if (source === null) continue;

    const { fields } = parseFrontmatter(source);
    const requires = parseRequires(fields.requires);
    const needsTools = parseRequires(fields.needs_tools);
    const agents = parseRequires(fields.agents);
    skills.push({
      name: fields.name ?? name,
      description: fields.description ?? "",
      path,
      scope,
      ...(requires.length > 0 ? { requires } : {}),
      ...(needsTools.length > 0 ? { needsTools } : {}),
      // Absent means a person wrote this one — see `Skill.author`. Read here rather than re-parsed
      // by every caller that needs to know who may change it.
      ...(fields.author?.trim() ? { author: fields.author.trim() } : {}),
      ...(agents.length > 0 ? { agents } : {}),
    });
  }

  return skills;
}

/**
 * `requires: dot, playwright` → `["dot", "playwright"]`. Also parses `needs_tools:`, same shape.
 *
 * Commas *or* whitespace, because both spellings show up in skills people write by hand and a field
 * that silently means nothing when you used the wrong separator is worse than no field. Names only —
 * a version constraint would imply this checks versions, and it checks `PATH`.
 */
function parseRequires(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[,\s]+/).map((name) => name.trim()).filter(Boolean))];
}

/**
 * What the skill folders hold, as one string that changes when a skill is added, removed or its `SKILL.md` edited: each
 * folder's skills by name, with their `SKILL.md`'s size and time. Only `SKILL.md`, which is all a prompt shows of one;
 * a script beside it is read when it runs. A folder that is not there is said as none.
 */
export function skillsStamp(dirs: readonly string[]): string {
  return dirs
    .map((dir) =>
      listDir(dir)
        .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
        .map((entry) => {
          const stat = statFile(join(dir, entry.name, "SKILL.md"));
          return stat ? `${entry.name}:${stat.size}:${Math.round(stat.mtimeMs)}` : "";
        })
        .filter(Boolean)
        .sort()
        .join(","),
    )
    .join("|");
}

/**
 * Names decided in `skills.toml` that match no directory in any pool — a typo, or a deleted skill.
 *
 * Worth surfacing rather than ignoring, and the `false` case is the sharp one: a misspelled name in
 * a file whose whole job is switching things off leaves a skill switched **on** that the operator
 * believes they switched off, and nothing anywhere would say so.
 */
export function unknownSkillStates(known: string[], states: Record<string, boolean>): string[] {
  // The names as *advertised* — `SKILL.md` frontmatter wins over the directory name, and a toggle
  // has to key on the name the prompt shows, because that is the one an agent or an operator would
  // type. Comparing against directory names instead would call a correct toggle a typo in the one
  // case where the two disagree.
  const present = new Set(known);
  return Object.keys(states)
    .filter((name) => !present.has(name))
    .sort();
}
