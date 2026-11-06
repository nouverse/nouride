/**
 * Agent pack loading — §4.1 SPEC, TD-008.
 *
 * An agent is a directory of markdown plus a `config.toml`. Nothing about identity
 * touches SQLite: these files are meant to be edited by hand and diffed in git, which
 * is the whole reason they are files.
 */

import { expandHome, isAbsolute, join, listDir, loadTomlIfExists, readTextFileIfExists, resolve, statFile } from "@nouride/runtime";
import {
  ConfigError,
  createLogger,
  type AgentConfig,
  type LLMDefaultsSection,
  type LoadedAgent,
  type PersonaFiles,
  type Skill,
} from "@nouride/shared";
import { parseAgentConfig, type ParseAgentOptions, type RawAgentConfig } from "./config.ts";
import { unknownPackKeys } from "./pack-keys.ts";
import { parseSkillStates, SKILL_STATES_FILE, type RawSkillStates } from "./skill-states.ts";
import { agentSkillPool, unknownSkillStates, type PoolSkill } from "./skills.ts";
import { effectiveMcpServers, readAgentMcp, readMcpLibrary } from "./mcp-library.ts";

const log = createLogger("persona");

/**
 * Directory name under `agents/` holding the one skill pool: `agents/skills/`.
 *
 * Every agent draws from it, on by default, switched off per agent in `skills.toml`. It is a
 * *reserved name* under `agents/` — `discoverAgents` skips it — so no agent may be called `skills`.
 */
export const SKILLS_DIR = "skills";

/**
 * `agents/shared/`, which no longer holds skills and is still reserved.
 *
 * Skills moved out of `agents/shared/skills/` into `agents/skills/`: one pool that every agent has
 * by default reads badly as a subdirectory of a word that meant "opt in from here". The directory
 * itself stays reserved because an install may keep `agents/shared/.credentials` there
 * (`config.example.toml` documents it), and because a pack directory called `shared` was never
 * loadable anyway.
 */
export const SHARED_DIR = "shared";

/** `agents/skills/` — the pool, for an `agents/` tree. */
export function skillsDirFor(agentsDir: string): string {
  return join(agentsDir, SKILLS_DIR);
}

/**
 * Where a project keeps its skills, relative to a root named in `[workspace] skill_roots`.
 *
 * `.agents/` rather than `.nouride/`: this repository already mirrors its Claude Code skills into
 * `.agents/skills/`, and a project that wants an agent to understand it should not have to keep one
 * directory per agent runtime. A convention is worth more than a namespace here.
 */
export const PROJECT_SKILLS_DIR = join(".agents", "skills");

const PERSONA_FILES = {
  identity: "IDENTITY.md",
  soul: "SOUL.md",
  agents: "AGENTS.md",
  memory: "MEMORY.md",
} as const;

export interface LoadAgentOptions {
  /** `agents/` — where the shared skill pool, `skills/`, lives. */
  agentsDir: string;
  /**
   * Where the skills that ship with the daemon live. Absent means none load.
   *
   * Resolved by the caller, not here: a checkout has them at `skills/` and an install has them
   * beside the executable, and this package has no business knowing which shape it is running in.
   */
  builtinSkillsDir?: string;
  llmDefaults: LLMDefaultsSection;
  /** Provider profile names, so a mistyped `provider` fails at load (see ParseAgentOptions). */
  knownProviders?: string[];
  /** Gateway instance ids, so a stale channel binding fails at load. */
  knownGateways?: string[];
  /** The coding CLIs an `[external]` pack may name (0.8.1), so an unknown one fails at load. */
  knownClis?: string[];
  /**
   * Skills no agent loads, whatever their own `skills.toml` says — `[skills] off`.
   *
   * A function as well as a list, for the same reason `knownProviders` is one: the registry reloads
   * packs without restarting the daemon, and a snapshot taken at boot would leave a toggle applying
   * only after a restart while the dashboard said it had taken effect.
   *
   * The other axis from `config.skills`, which is one agent's answer. This one is the operator's,
   * and it is the only removal a built-in has: those ship inside the executable, so deleting one is
   * refused and would be undone by the next upgrade anyway.
   */
  skillsOffGlobally?: readonly string[] | (() => readonly string[]);
}

export async function loadAgent(id: string, opts: LoadAgentOptions): Promise<LoadedAgent> {
  const dir = join(opts.agentsDir, id);
  if (statFile(dir)?.isDirectory !== true) {
    throw new ConfigError(`agent directory not found: ${dir}`);
  }

  const persona = await loadPersona(dir);
  if (!persona.identity.trim()) {
    // IDENTITY.md is the one file with no sensible default: without it the agent has
    // no name, no role, and nothing to say about itself in the system prompt.
    throw new ConfigError(`agents/${id}/IDENTITY.md is missing or empty`);
  }

  const raw = await loadTomlIfExists<RawAgentConfig>(join(dir, "config.toml"));
  // Said as the daemon's config says its own, and the agent still loads: a word nothing reads changes nothing.
  for (const key of unknownPackKeys(raw)) log.warn("unknown pack config key ignored", { key: `agents/${id}/config.toml ${key}` });
  const parseOptions: ParseAgentOptions = {
    defaults: opts.llmDefaults,
    ...(opts.knownProviders ? { knownProviders: opts.knownProviders } : {}),
    ...(opts.knownGateways ? { knownGateways: opts.knownGateways } : {}),
    ...(opts.knownClis ? { knownClis: opts.knownClis } : {}),
  };
  const config = parseAgentConfig(id, raw, parseOptions);

  // Which skills this agent carries, from its own `skills.toml`. Absent file, or a name absent from
  // it, means on — see `AgentConfig.skills`.
  const rawStates = await loadTomlIfExists<RawSkillStates>(join(dir, SKILL_STATES_FILE));
  config.skills = parseSkillStates(rawStates, `agents/${id}/${SKILL_STATES_FILE}`);

  // The install's MCP servers this agent switched on, with its own credentials laid over — `mcp-library.ts`.
  config.mcp = await readAgentMcp(dir, id);
  config.mcpServers = effectiveMcpServers(id, (await readMcpLibrary(opts.agentsDir)).servers, config.mcp);

  // Resolved against the *pack's own directory*, not the daemon's cwd, and with `~` expanded first.
  //
  // Both halves were wrong. A tilde is not an absolute path, so `~/project` stayed literal and the
  // sandbox compared against a directory named `~` — an agent pointed at a file reported it missing
  // while `ls` showed it sitting there. And a relative root is naturally read as relative to the pack
  // that declares it, since that is the file the operator is looking at while writing it.
  const absolutize = (root: string): string => {
    const expanded = expandHome(root);
    return isAbsolute(expanded) ? expanded : resolve(dir, expanded);
  };
  config.workspaceRoots = config.workspaceRoots.map(absolutize);
  // Same treatment, same reasons — a tilde is not an absolute path, and a relative path is naturally
  // read against the pack that declares it.
  config.skillRoots = config.skillRoots.map(absolutize);

  // A root that does not exist is a warning at load, not a mystery at the first tool call.
  //
  // Observed: a config said `roots = ["~/nouride-test/project"]` while the project actually lived under
  // `~/Workspace/nouverse/nouride-test`. The tilde expanded correctly to a directory that was simply not
  // there, so the agent tried to read a file, got refused, globbed, found nothing, and looped — while
  // `doctor` and `status` reported everything green. Nothing anywhere said the root was missing.
  //
  // A warning rather than a refusal: the directory may legitimately appear later (a repo not yet cloned,
  // a mount not yet up), and an agent whose *other* roots work should still start.
  // A skill root with no `.agents/skills/` contributes nothing and is almost always a typo: the
  // operator named the project directory but the skills live one level in. Warned rather than
  // refused, because the directory may legitimately appear later — a repo not cloned yet.
  for (const root of config.skillRoots) {
    if (statFile(join(root, PROJECT_SKILLS_DIR))?.isDirectory !== true) {
      log.warn("skill root has no .agents/skills, so no project skills will load from it", {
        agent_id: id,
        root,
        expected: join(root, PROJECT_SKILLS_DIR),
      });
    }
  }

  for (const root of config.workspaceRoots) {
    if (statFile(root)?.isDirectory !== true) {
      log.warn("workspace root does not exist, so the agent will find nothing there", {
        agent_id: id,
        root,
        hint: `check [workspace] roots in ${join(dir, "config.toml")}`,
      });
    }
  }

  const skills = await loadAgentSkills(id, opts.agentsDir, opts.builtinSkillsDir, config, offGlobally(opts));

  return {
    config,
    persona,
    skills,
    dir,
    loadedAt: newestMtime(dir),
  };
}

/**
 * The agent with its skills read again (0.8.13), or null when they read as before: a skill added to, removed from or
 * edited in the built-in folder or the pool, seen without a restart and without a reload — which reconnects every MCP
 * server of every agent, too much for a SKILL.md.
 */
export async function reloadSkills(agent: LoadedAgent, opts: LoadAgentOptions): Promise<LoadedAgent | null> {
  const skills = await loadAgentSkills(agent.config.id, opts.agentsDir, opts.builtinSkillsDir, agent.config, offGlobally(opts));
  const said = (list: readonly Skill[]) => JSON.stringify(list.map((skill) => [skill.name, skill.description, skill.path, skill.requires, skill.needsTools]));
  return said(skills) === said(agent.skills) ? null : { ...agent, skills };
}

async function loadPersona(dir: string): Promise<PersonaFiles> {
  const read = (file: string) => readTextFileIfExists(join(dir, file));

  const [identity, soul, agents, memory] = await Promise.all([
    read(PERSONA_FILES.identity),
    read(PERSONA_FILES.soul),
    read(PERSONA_FILES.agents),
    read(PERSONA_FILES.memory),
  ]);

  return {
    identity: identity ?? "",
    ...(soul ? { soul } : {}),
    ...(agents ? { agents } : {}),
    ...(memory ? { memory } : {}),
  };
}

/** `[skills] off`, resolved now rather than at boot — see `LoadAgentOptions.skillsOffGlobally`. */
function offGlobally(opts: LoadAgentOptions): ReadonlySet<string> {
  const value = opts.skillsOffGlobally;
  return new Set(typeof value === "function" ? value() : (value ?? []));
}

async function loadAgentSkills(
  id: string,
  agentsDir: string,
  builtinDir: string | undefined,
  config: AgentConfig,
  offGlobally: ReadonlySet<string>,
): Promise<Skill[]> {
  const pool = await agentSkillPool({
    poolDir: skillsDirFor(agentsDir),
    builtinDir,
    states: config.skills,
    offGlobally: [...offGlobally],
    agent: id,
  });

  // A name decided in `skills.toml` that exists in neither pool is a typo or a deleted skill, and
  // the `false` case is the one that bites: a misspelt name leaves a skill switched *on* that the
  // operator believes they switched off.
  //
  // Not one in `skills/.archive/`, which a merge or an archive retired: not a typo, and its switch
  // is kept so the agent's choice holds if it is brought back. Said on every reload, it was a
  // warning per agent for each skill approved after a merge (0.8.8, the live box).
  const archived = listDir(join(skillsDirFor(agentsDir), ".archive")).filter((entry) => entry.isDirectory);
  const unknown = unknownSkillStates(
    [...pool.map((skill) => skill.name), ...archived.map((entry) => entry.name)],
    config.skills,
  );
  if (unknown.length > 0) {
    log.warn("skills.toml names skills that do not exist", { agent_id: id, unknown });
  }

  /**
   * Global off wins over the pack's answer, and there is no way to opt back in per agent.
   *
   * The reverse would make the switch advisory: an operator who turned a skill off everywhere would
   * still have to check six `skills.toml` files to know whether it was actually off. "Off" has to
   * mean off, or it is not the removal a built-in needs.
   */
  return pool.filter((skill) => skill.enabled && !skill.offGlobally).map(strip);
}

/** Drop the per-agent answer once it has been applied — a `Skill` in a prompt has no state. */
function strip({ enabled: _enabled, decided: _decided, offGlobally: _off, ...skill }: PoolSkill): Skill {
  return skill;
}

/**
 * Newest mtime across the pack, for hot-reload detection (§14.3 SPEC). Only the top level is
 * walked — deep recursion over an agent's workspace would make every reload check proportional to
 * whatever the agent has been writing.
 *
 * The top level is now enough: `skills.toml` is a file in it, and the skills themselves left the
 * pack for `agents/skills/`. A pool edit is therefore not seen here — the same as before for shared
 * skills, and the pool is reloaded explicitly by whatever wrote to it (`skill_create`, the Skills
 * Workshop, `nouride agent reload`).
 */
function newestMtime(dir: string): number {
  let newest = statFile(dir)?.mtimeMs ?? 0;

  for (const entry of listDir(dir)) {
    const stat = statFile(join(dir, entry.name));
    if (stat) newest = Math.max(newest, stat.mtimeMs);
  }

  return newest;
}

export interface DiscoveryResult {
  agents: LoadedAgent[];
  /** Packs that failed to load, with the reason. Boot continues without them. */
  failures: { id: string; error: string }[];
}

/**
 * Load every pack under `agentsDir`.
 *
 * One broken pack does not stop the others: a daemon that refuses to boot because of a
 * typo in one agent's config takes down every other agent and the dashboard you would
 * use to fix it.
 */
export async function discoverAgents(opts: LoadAgentOptions): Promise<DiscoveryResult> {
  // `skills` and `shared` are reserved names under `agents/`, not packs: the first is the pool every
  // agent draws from, the second may hold an install's `.credentials`. Skipped rather than attempted,
  // because attempting them puts "IDENTITY.md is missing" in `failures` for a directory that was
  // never an agent — and boot then reports two broken packs on a healthy install.
  const ids = listDir(opts.agentsDir)
    .filter((e) => e.isDirectory && e.name !== SHARED_DIR && e.name !== SKILLS_DIR && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  const agents: LoadedAgent[] = [];
  const failures: DiscoveryResult["failures"] = [];

  for (const id of ids) {
    try {
      agents.push(await loadAgent(id, opts));
    } catch (err) {
      failures.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { agents, failures };
}
