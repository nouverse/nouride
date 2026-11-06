/**
 * Agent registry — discovery, lookup and runtime state.
 *
 * The *pack* (files on disk) is loaded by `@nouride/persona`. What lives here is
 * everything the daemon knows that the files do not: which agents are paused, when each
 * was last loaded, and which packs failed.
 */

import {
  ConfigError,
  createLogger,
  type AgentRuntimeStatus,
  type LLMDefaultsSection,
  type LoadedAgent,
} from "@nouride/shared";
import { discoverAgents, loadAgent, reloadSkills } from "./loader.ts";

const log = createLogger("agents.registry");

export interface RegistryOptions {
  agentsDir: string;
  llmDefaults: LLMDefaultsSection;
  /** `skills/` — the ones that ship with the daemon. Absent means none load. */
  builtinSkillsDir?: string;
  /**
   * Profile names and gateway ids, so a stale reference in a pack fails at load.
   *
   * A function, because the set changes while the daemon runs: the setup wizard adds a provider and
   * then immediately creates an agent that names it. Found live — with a snapshot taken at boot, the
   * first agent a fresh install created was refused against the profile list from before the profile
   * existed, and the error blamed the operator's brand new configuration.
   */
  knownProviders?: string[] | (() => string[]);
  knownGateways?: string[];
  /** The coding CLIs an `[external]` pack may name (0.8.1). A function, so a CLI added to config.toml counts at reload. */
  knownClis?: string[] | (() => string[]);
  /** `[skills] off` — see `LoadAgentOptions.skillsOffGlobally`. A function, so a reload sees a change. */
  skillsOffGlobally?: readonly string[] | (() => readonly string[]);
  /**
   * Where the pause marks are kept, so a restart does not resume an agent somebody stopped (D15).
   *
   * They lived in this process alone, and a nightly update is a restart: an agent stopped with `/stop` was answering
   * again the next morning. Absent — a command that loads the packs once and exits — they are this process's only.
   */
  pauses?: { load(): readonly string[]; save(ids: readonly string[]): void };
  /**
   * Why the daemon will not take a pack that loads, or null — what the pack alone cannot know is wrong: the daemon's
   * orchestrator answered by a coding CLI (0.8.1). Asked on a reload of one pack, which every save of a pack ends in,
   * so the save is put back and this is its reason; the running agent stays as it was.
   */
  refuse?: (agent: LoadedAgent) => string | null;
}

export interface AgentFailure {
  id: string;
  error: string;
}

export class AgentRegistry {
  private agents = new Map<string, LoadedAgent>();
  private paused: Set<string>;
  private failures: AgentFailure[] = [];

  private constructor(private readonly options: RegistryOptions) {
    this.paused = new Set(options.pauses?.load() ?? []);
  }

  /** Options with `knownProviders` resolved now, rather than whenever the registry was built. */
  private loadOptions(): Omit<RegistryOptions, "knownProviders" | "knownClis" | "refuse"> & { knownProviders?: string[]; knownClis?: string[] } {
    const { knownProviders, knownClis, refuse: _refuse, ...rest } = this.options;
    return {
      ...rest,
      ...(knownProviders
        ? { knownProviders: typeof knownProviders === "function" ? knownProviders() : knownProviders }
        : {}),
      ...(knownClis ? { knownClis: typeof knownClis === "function" ? knownClis() : knownClis } : {}),
    };
  }

  static async create(options: RegistryOptions): Promise<AgentRegistry> {
    const registry = new AgentRegistry(options);
    await registry.reloadAll();
    if (options.pauses && registry.paused.size > 0) {
      log.info("agents still paused from before the restart; /start resumes one", { agent_ids: [...registry.paused].sort() });
    }
    return registry;
  }

  /**
   * Called with each pack after it is reloaded.
   *
   * Exists because a reload re-reads the agent's MCP servers and nothing acted on it: connections were
   * opened once at boot and never revisited, so editing a server's command and reloading left the
   * daemon talking to the old one while reporting success. The change appeared to apply and did not —
   * found by moving a server's checkout and watching the child keep running from the deleted path.
   *
   * A callback rather than a dependency on the MCP manager: this class knows about packs, and giving
   * it a tool subsystem to call would invert that.
   */
  private reloaded: ((agent: LoadedAgent) => void)[] = [];

  onReloaded(listener: (agent: LoadedAgent) => void): void {
    this.reloaded.push(listener);
  }

  private announce(agent: LoadedAgent): void {
    for (const listener of this.reloaded) {
      // Never fatal: a listener that throws must not turn a reload into a failure, or `/reset` starts
      // reporting an error for work that did land.
      try {
        listener(agent);
      } catch (err) {
        log.error("reload listener failed", { agent_id: agent.config.id, error: String(err) });
      }
    }
  }

  /**
   * Called when an agent wakes — the pause mark lifted, by a person (0.8.0: asleep). What waited for it — a job's end, a
   * mission's next turn — goes on then. Never fatal, like a reload's listener.
   */
  private woke: ((id: string) => void)[] = [];

  onWoke(listener: (id: string) => void): void {
    this.woke.push(listener);
  }

  /** Called with each agent whose skills `refreshSkills` read differently — and with nothing else of its pack changed. */
  private skillsChanged: ((agent: LoadedAgent) => void)[] = [];

  onSkillsChanged(listener: (agent: LoadedAgent) => void): void {
    this.skillsChanged.push(listener);
  }

  /**
   * Every agent's skills read again (0.8.13), the rest of each pack as it is: what the daemon does when the skill
   * folders change on disk. Its own listeners, not a reload's — a reload reconnects the agent's MCP servers. Returns the
   * agents whose skills changed.
   */
  async refreshSkills(): Promise<string[]> {
    const options = this.loadOptions();
    const changed: LoadedAgent[] = [];
    for (const agent of [...this.agents.values()]) {
      const next = await reloadSkills(agent, options);
      // Reloaded meanwhile — a save of its pack — is newer than this read: left as it is.
      if (!next || this.agents.get(agent.config.id) !== agent) continue;
      this.agents.set(agent.config.id, next);
      changed.push(next);
    }
    for (const agent of changed) {
      for (const listener of this.skillsChanged) {
        try {
          listener(agent);
        } catch (err) {
          log.error("skills listener failed", { agent_id: agent.config.id, error: String(err) });
        }
      }
    }
    return changed.map((agent) => agent.config.id);
  }

  async reloadAll(): Promise<void> {
    const { agents, failures } = await discoverAgents(this.loadOptions());

    this.agents = new Map(agents.map((agent) => [agent.config.id, agent]));
    this.failures = failures;

    // Pause marks survive a reload: /stop is an operator decision about the agent, not
    // a property of the files, and un-pausing silently on reload would be a surprise.
    // A pack that failed to load is still that agent — fixed, it comes back paused; only one gone is forgotten.
    let forgot = false;
    for (const id of this.paused) {
      if (this.agents.has(id) || failures.some((failure) => failure.id === id)) continue;
      this.paused.delete(id);
      forgot = true;
    }
    if (forgot) this.savePauses();

    for (const failure of failures) {
      log.error("agent pack failed to load", { agent_id: failure.id, error: failure.error });
    }
    log.info("agents loaded", {
      count: this.agents.size,
      ids: [...this.agents.keys()],
      failed: failures.length,
    });

    for (const agent of this.agents.values()) this.announce(agent);
  }

  /** Reload one pack in place (§14.3 SPEC, `/reload`). */
  async reload(id: string): Promise<LoadedAgent> {
    const agent = await loadAgent(id, this.loadOptions());
    const refused = this.options.refuse?.(agent);
    if (refused) throw new ConfigError(refused);
    this.agents.set(id, agent);
    this.failures = this.failures.filter((f) => f.id !== id);
    log.info("agent reloaded", { agent_id: id });
    this.announce(agent);
    return agent;
  }

  get(id: string): LoadedAgent | undefined {
    return this.agents.get(id);
  }

  /** Every loaded pack, including disabled ones — the dashboard shows those too. */
  all(): LoadedAgent[] {
    return [...this.agents.values()];
  }

  /**
   * Packs turned on in config, paused or not.
   *
   * This — not `active()` — is what the router matches against. A paused agent must still be
   * addressable, or `/start` can never reach it: routing over `active()` made a stopped agent
   * invisible, so the command that would resume it found no recipient. The pause is enforced
   * after hooks run, in the pipeline.
   */
  enabled(): LoadedAgent[] {
    return this.all().filter((a) => a.config.enabled);
  }

  /** Packs that will answer an ordinary message: enabled and not paused. */
  active(): LoadedAgent[] {
    return this.enabled().filter((a) => !this.paused.has(a.config.id));
  }

  status(id: string): AgentRuntimeStatus {
    if (this.failures.some((f) => f.id === id)) return "error";
    return this.paused.has(id) ? "paused" : "running";
  }

  pause(id: string): boolean {
    if (!this.agents.has(id) || this.paused.has(id)) return false;
    this.paused.add(id);
    this.savePauses();
    log.info("agent paused", { agent_id: id });
    return true;
  }

  resume(id: string): boolean {
    if (!this.paused.delete(id)) return false;
    this.savePauses();
    log.info("agent resumed", { agent_id: id });
    for (const listener of this.woke) {
      try {
        listener(id);
      } catch (err) {
        log.error("wake listener failed", { agent_id: id, error: String(err) });
      }
    }
    return true;
  }

  /** Every mark, written down at once — a restart reads them back (`RegistryOptions.pauses`). */
  private savePauses(): void {
    this.options.pauses?.save([...this.paused].sort());
  }

  isPaused(id: string): boolean {
    return this.paused.has(id);
  }

  loadFailures(): AgentFailure[] {
    return [...this.failures];
  }
}
