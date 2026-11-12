/**
 * First-run setup, driven from a browser.
 *
 * The target this exists for: `docker compose up`, open the dashboard, and end with an agent that
 * answers — without a terminal at any point. Everything here is something an operator would otherwise
 * have done by hand-editing `config.toml` and a persona pack, so the ordering follows what they cannot
 * skip: an account, then a provider (nothing works without one), then an agent.
 *
 * Applied live rather than by restarting. Writing the file and asking the operator to restart is the
 * honest fallback, and it is what the reference implementations do — but on a first run a restart is
 * indistinguishable from a crash, and it happens at the exact moment the operator has least evidence
 * the thing works at all.
 */

import { cleanHeadline, HEADLINE_MAX } from "./identity-headline.ts";
import { LOCAL_GATEWAY_ID, TERMINAL_SENDER } from "@/modules/gateways/local.ts";
import { join, listDir, parseToml, removePath, writeTextFileAtomic } from "@nouride/runtime";
import { editDaemonConfig } from "@/modules/config/config-file.ts";
import { saveProvider as saveProfile } from "@/modules/config/settings/providers.ts";
import { createLogger, type AgentAccess, type GlobalConfig } from "@nouride/shared";
import type { SecretStore } from "@nouride/secrets";
import { BUILTIN_TOOLS, underHeading, type AgentRegistry } from "@nouride/persona";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { AutoApprovePort } from "@/modules/tools/auto-approve.store.ts";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { probeProvider, type ProbeResult, type ProviderKind } from "@/modules/setup/probe.ts";
import { STARTER_AGENTS, STARTER_MEMORY, STARTER_README } from "@/modules/setup/starter-pack.ts";
import { namingOrchestrator, setAgentAccess, setAgentTools, setOrchestrator } from "./agent-access.ts";
import { externalAgentLlm, setAnsweredBy, setExternal, type ExternalSettings } from "./external-agent.ts";
import { setEffort } from "./agent-effort.ts";
import { lookLines, setLook, type LookChange } from "./agent-look.ts";
import type { EmbeddedGateway } from "@/modules/gateways/nougate-inproc.ts";
import { presetOf, toolsFor, type PresetId } from "./presets.ts";

const log = createLogger("setup");

/** The profile the wizard writes when no name is given. The secret it names is the Models page's rule: `<name>_api_key`. */
export const SETUP_PROFILE = "default";

/**
 * The profile "Use Nougate LLM Gateway" writes, named after the gateway as the wizard's old offer
 * named it — so a profile filled in by hand on an earlier version is the same profile, not a second.
 */
export const GATEWAY_PROFILE = "nougate";

/** What the daemon's own key is called on the gateway's API Keys page — so nobody revokes it unknowingly. */
const GATEWAY_KEY_NAME = "Nouride agents";

const VALID_AGENT_ID = /^[a-z][a-z0-9-]{1,31}$/;

/** Ids the router or the filesystem would fight over. */
// `skills` is the pool directory and `shared` may hold `.credentials`; `discoverAgents` skips both, so
// a pack created under either name would be written and then never load.
const RESERVED_AGENT_IDS = new Set(["shared", "skills", "all", "none", "system", "nouride", "default"]);

/**
 * The first agent gets everything this daemon actually built.
 *
 * It used to be a hand-written list, and a hand-written list of tools goes stale the same way the
 * hand-written list of CLI commands did: `skill_improve` shipped, `[skills.learning] mode` defaults to proposing,
 * and the first agent on every fresh install was the one agent that could not raise a skill draft —
 * while `skill_create`, which writes a skill straight into the pool, was granted. The safer of the
 * two was the one withheld, and nothing said so.
 *
 * So the daemon path asks the live registry instead: a tool registered next month is offered to the
 * next agent created, with no list to remember. `FALLBACK_TOOLS` covers `nouride setup`, which runs
 * before any registry exists — and a test asserts it still covers everything the registry can
 * produce, so a new tool cannot slip past both paths in silence.
 *
 * `ask_agent`, `attachment_read` and `notes` are excluded from what gets *written*, and that is not an
 * omission. All three follow the daemon rather than the pack — `resolveToolset` adds them per turn when
 * the daemon can serve them and withdraws them when it cannot, whatever the config says. A line in
 * `config.toml` that has no effect is a lie in a file people hand-edit.
 */
const NOT_WRITTEN = new Set(["ask_agent", "attachment_read", "notes"]);

/**
 * What "no terminal" has to mean, or it means nothing.
 *
 * `session` is `exec` for a program that asks something back — a pty where one can be had. Leaving
 * it behind while withholding `exec` would hand over the same capability through the door with the
 * longer doc comment.
 */
const SHELL_TOOLS = new Set(["exec", "session"]);

/**
 * Every built-in, for the path that has no registry to ask — what `["*"]` means too (`BUILTIN_TOOLS`).
 * Kept honest by `setup-tools.test.ts`.
 */
export const FALLBACK_TOOLS = BUILTIN_TOOLS;

export interface SetupState {
  hasUser: boolean;
  hasProvider: boolean;
  hasAgent: boolean;
  /** True once all three are done — what the dashboard routes on. */
  complete: boolean;
}

export interface SetupDeps {
  config: GlobalConfig;
  /**
   * The file to write settings into.
   *
   * Passed in rather than derived from `dataDir`. It used to be `<dataDir>/config.toml`, which was
   * true only while the data directory was also the install root — once `data/`, `agents/` and
   * `workspace/` became three independently configurable paths under `.nouride/`, deriving the config
   * location from one of them meant the wizard could write a file the loader never reads. The daemon
   * already knows this path: it is where the config was loaded from.
   */
  configPath: string;
  dataDir: string;
  agentsDir: string;
  secrets: SecretStore;
  providers: ProviderRegistry;
  registry: AgentRegistry;
  audit?: AuditPort;
  autoApprove?: AutoApprovePort;
  userCount: () => number;
  /**
   * Every tool name this daemon built, for the first agent's `[tools] enabled`.
   *
   * The live map, so a tool added later needs no list updated anywhere. Absent on the `nouride setup`
   * path, which runs before a registry exists — see `FALLBACK_TOOLS`.
   */
  builtinToolNames?: () => string[];
  /**
   * The gateway this process hosts, when the build carries it and it is switched on — what lets setup connect to it
   * without anybody typing a key (`useBundledGateway`). Asked at each use: the wizard turns it on after boot.
   */
  bundledGateway?: () => Pick<EmbeddedGateway, "url" | "ensureHostKey" | "connectedModels"> | null;
  fetchImpl?: typeof fetch;
}

export class SetupService {
  constructor(private readonly deps: SetupDeps) {}

  private configPath(): string {
    return this.deps.configPath;
  }

  /**
   * Every tool an agent's `[tools] enabled` can name on this daemon — what a preset picks from and
   * what the dashboard's tool switches list. Without the two that follow the daemon (`NOT_WRITTEN`).
   */
  availableTools(): string[] {
    return (this.deps.builtinToolNames?.() ?? FALLBACK_TOOLS).filter((name) => !NOT_WRITTEN.has(name));
  }

  /** Switch an existing agent's tools (`agent-access.ts`). */
  async setAgentTools(input: { agentId: string; tools: readonly string[]; actor: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    return await setAgentTools(this.deps, { ...input, available: this.availableTools() });
  }

  /** Whether an agent's connections take new senders (`agent-access.ts`). */
  async setAgentAccess(input: { agentId: string; access: AgentAccess; actor: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    return await setAgentAccess(this.deps, input);
  }

  /** An external agent's CLI settings (`external-agent.ts`). */
  async setExternal(input: { agentId: string; settings: ExternalSettings; actor: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    return await setExternal(this.deps, input);
  }

  /** An agent's `[llm] effort`, or back to the install's (`agent-effort.ts`). */
  async setEffort(input: { agentId: string; effort: string; actor: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    return await setEffort(this.deps, input);
  }

  /** Whether a coding CLI answers an agent that exists, or none (`external-agent.ts`). */
  async setAnsweredBy(input: { agentId: string; cli: string | null; profile?: string; actor: string }): ReturnType<typeof setAnsweredBy> {
    return await setAnsweredBy(this.deps, input);
  }

  /** An agent's cat in Nouride Office (`agent-look.ts`). */
  async setLook(input: { agentId: string; look: LookChange; actor: string }): ReturnType<typeof setLook> {
    return await setLook(this.deps, input);
  }

  /** Make one agent the default (`agent-access.ts`). */
  async setOrchestrator(input: { agentId: string; actor: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    return await setOrchestrator(this.deps, input);
  }

  state(): SetupState {
    const hasUser = this.deps.userCount() > 0;
    // "Configured" means a profile whose credential actually resolves. A profile with a missing key is
    // the state a half-finished setup leaves behind, and treating it as done sends the operator to a
    // chat window that fails on the first message.
    const hasProvider = this.deps.providers.available().some((p) => p.hasCredential);
    // Any agent there is, asleep or switched off: the wizard is for an install with none. Counted as only those taking
    // work, an install whose agents were all put to sleep for the night sent every page of the dashboard to setup.
    const hasAgent = this.deps.registry.all().length > 0;

    return { hasUser, hasProvider, hasAgent, complete: hasUser && hasProvider && hasAgent };
  }

  /**
   * Check an endpoint without saving anything. The wizard calls this to fill its model picker; a saved profile's
   * listing passes the profile's own `headers`, which its every request carries.
   */
  probe(input: { kind: ProviderKind; baseUrl: string; apiKey: string; headers?: Record<string, string> }): Promise<ProbeResult> {
    return probeProvider({
      ...input,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
  }

  /** What the settings writers need, from this service's own deps. */
  private settingsDeps() {
    const { config, configPath, secrets, providers, audit } = this.deps;
    return { config, configPath, secrets, providers, ...(audit ? { audit } : {}) };
  }

  /**
   * Save the one provider profile this daemon is set up with.
   *
   * The key goes to the secret store and its **name** goes into `config.toml`. That indirection is the
   * rule the whole credential design rests on, and this is the single most likely place to break it —
   * a wizard that writes what the user typed straight into the config file commits a live key to
   * whatever they back that directory up to.
   */
  async saveProvider(input: {
    kind: ProviderKind;
    /** Custom profile name. Falls back to SETUP_PROFILE ("default") when omitted. */
    name?: string;
    baseUrl: string;
    apiKey: string;
    actor: string;
    /** Skip the live check. For a provider that has no model listing, not for convenience. */
    skipProbe?: boolean;
  }): Promise<{ ok: true; models: string[]; secret: string } | { ok: false; error: string }> {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) return { ok: false, error: "A base URL is required." };
    if (!input.apiKey.trim()) return { ok: false, error: "An API key is required." };

    let models: string[] = [];
    if (!input.skipProbe) {
      const probe = await this.probe({ kind: input.kind, baseUrl, apiKey: input.apiKey });
      if (!probe.ok) return { ok: false, error: probe.error ?? "The endpoint did not answer." };
      models = probe.models;
    }

    /**
     * Written by the Models page's own writer, not a second one of this wizard's: the two disagreed on the secret's
     * name (`<name>_provider` here, `<name>_api_key` there) and on what a name may be, so a profile one made the other
     * could not edit, and the key it replaced was left in the store with nothing naming it. One writer, one rule —
     * and an existing profile keeps the secret it already names.
     */
    const name = (input.name?.trim() || SETUP_PROFILE).toLowerCase();
    const saved = await saveProfile(this.settingsDeps(), { name, kind: input.kind, baseUrl, apiKey: input.apiKey, actor: input.actor });
    if (!saved.ok) return saved;
    // The secret the profile names — its own, when it had one — for whoever says where the key went.
    return { ok: true, models, secret: this.deps.config.providers[name]?.apiKeySecret ?? `${name}_api_key` };
  }

  /**
   * Point the daemon at the gateway it hosts, with a key it mints itself — the wizard's "Use Nougate
   * LLM Gateway".
   *
   * The person signs in to an account (Claude, ChatGPT, Copilot…) through the gateway's own dashboard
   * API first; that is what makes a model answer, and it is theirs to do. Everything after it is
   * plumbing they should never see: a gateway key, the secret it is stored under, a provider
   * profile. So none of it is asked for.
   *
   * Refused before any account is signed in. The profile would save and the agent step would offer
   * models no account can serve — the first message would fail with an error about a provider the
   * person never chose.
   *
   * Pressing it twice reuses the key (`ensureHostKey` hands back one that still verifies), so the
   * gateway's API Keys page does not fill up with copies.
   */
  async useBundledGateway(input: { actor: string }): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
    const gateway = this.deps.bundledGateway?.() ?? null;
    if (!gateway) return { ok: false, error: "This build has no LLM gateway running." };

    const models = gateway.connectedModels();
    if (models.length === 0) return { ok: false, error: "Sign in to at least one account first." };

    // The secret the profile already names, when there is one: its key is handed back while it still verifies.
    const secretName = this.deps.config.providers[GATEWAY_PROFILE]?.apiKeySecret ?? `${GATEWAY_PROFILE}_api_key`;
    const { key, minted } = await gateway.ensureHostKey(GATEWAY_KEY_NAME, this.deps.secrets.resolve(secretName) ?? null);
    const saved = await this.saveProvider({
      kind: "openai",
      name: GATEWAY_PROFILE,
      baseUrl: `${gateway.url}/openai/v1`,
      apiKey: key,
      actor: input.actor,
      // The gateway is in this process and the key was minted a moment ago; there is nothing a
      // round trip through its port would tell us that `connectedModels` has not.
      skipProbe: true,
    });
    if (!saved.ok) return saved;

    log.info("connected to the bundled gateway", { minted_key: minted, models: models.length, actor: input.actor });
    return { ok: true, models };
  }

  /**
   * List models from the first usable provider profile.
   *
   * Called when the agent step loads without cached models — e.g. after a page refresh on step 2,
   * or when the provider was configured via CLI before the dashboard was opened.
   */
  async listModels(): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
    const profile = this.usableProfile();
    if (!profile) return { ok: false, error: "No provider configured yet." };

    const entry = this.deps.providers.available().find((p) => p.name === profile);
    if (!entry) return { ok: false, error: "Provider profile not found." };

    // The hosted gateway's `/models` lists every model of every provider, signed in or not, and the
    // picker's first entry would then be one no account serves. The gateway knows which it can.
    const gateway = this.deps.bundledGateway?.() ?? null;
    if (gateway && entry.baseUrl.startsWith(gateway.url)) {
      const connected = gateway.connectedModels();
      if (connected.length > 0) return { ok: true, models: connected };
    }

    const saved = this.deps.config.providers[profile]!;
    const apiKey = this.deps.secrets.resolve(saved.apiKeySecret);
    if (!apiKey) return { ok: false, error: "Provider credential not found." };

    const probe = await this.probe({
      kind: entry.kind as ProviderKind,
      baseUrl: entry.baseUrl,
      apiKey,
      ...(saved.headers ? { headers: saved.headers } : {}),
    });
    return probe.ok
      ? { ok: true, models: probe.models }
      : { ok: false, error: probe.error ?? "Could not list models." };
  }

  /**
   * The provider profile a new agent should name.
   *
   * **Not** always the one this wizard writes. The provider step is skipped when the instance already
   * has a usable profile — which is the normal case for anyone who set the daemon up by hand and then
   * opened the dashboard — and in that case `default` was never created. Writing it anyway produced a
   * pack that would not load, and an error blaming the operator's configuration for the name this code
   * chose. Found by the operator on his own install, on the first agent he created.
   *
   * Only profiles whose credential resolves are considered: naming one without a key writes a pack that
   * loads and then fails on its first message, which is the harder failure to trace of the two.
   */
  private usableProfile(): string | null {
    const credentialed = this.deps.providers.available().filter((p) => p.hasCredential);
    if (credentialed.some((p) => p.name === SETUP_PROFILE)) return SETUP_PROFILE;
    return credentialed[0]?.name ?? null;
  }

  /**
   * Create the first agent from the wizard.
   *
   * Writes the same four files a hand-made pack has, then loads it — so what the wizard produces is an
   * ordinary persona pack the operator can edit in the file editor afterwards, not a special case with
   * its state somewhere else.
   */
  async createAgent(input: {
    id: string;
    displayName: string;
    systemPrompt: string;
    model: string;
    actor: string;
    /** Overrides the resolved profile. For an instance with more than one usable provider. */
    provider?: string;
    /**
     * Whether this agent gets a shell.
     *
     * The comment above `autoOn` used to read "Let the agent run shell commands. Off unless the
     * operator asked for it." — orphaned, with no field under it, which is what a removed parameter
     * leaves behind. Both dashboards had been sending `allow_exec` the whole time: the first-run
     * wizard with a toggle defaulting to on, the new-agent form with one defaulting to off. Neither
     * reached here. The route dropped it, this signature had no name for it, and every agent ever
     * created got `exec` — including the ones created by somebody who had deliberately left the
     * switch alone, reading "For security, chat gateways require a sender allowlist when enabled."
     *
     * Absent means yes, so the CLI wizard and anything else that does not pass it behave exactly as
     * before. Only an explicit `false` withholds, and it withholds `session` with it: that is the
     * same capability with a prompt attached, and a toggle that leaves it behind is decoration.
     *
     * `nouride` stays either way. Withholding a shell is not withholding the daemon's own control
     * surface — see the note on `createNourideCliTool`, which exists precisely for that agent.
     */
    allowExec?: boolean;
    /** Automatically enable standing auto-approval for command/tool execution. */
    autoOn?: boolean;
    /** What it starts as (`presets.ts`). Absent is `nourider`: every tool, which is what the wizard makes. */
    preset?: PresetId;
    /** For `custom`: the tools picked. */
    tools?: readonly string[];
    /** What it is for, said to its peers — `identity-headline.ts`. Absent or blank is the preset's. */
    headline?: string;
    /**
     * An external agent (0.8.1): its turns answered by this coding CLI, on this profile. Its `[llm]` stays — the model
     * of the work Nouride does for it, a mission's review — and is the install's default model where none is given.
     */
    external?: { cli: string; profile?: string };
  }): Promise<{ ok: true; id: string; provider: string } | { ok: false; error: string }> {
    const id = input.id.trim().toLowerCase();
    if (!VALID_AGENT_ID.test(id)) {
      return {
        ok: false,
        error:
          "An agent id is 2–32 characters: lowercase letters, digits and hyphens, starting with a letter.",
      };
    }
    if (RESERVED_AGENT_IDS.has(id)) return { ok: false, error: `"${id}" is reserved.` };
    if (this.deps.registry.get(id)) return { ok: false, error: `An agent called "${id}" already exists.` };

    const dir = join(this.deps.agentsDir, id);
    if (listDir(dir).length > 0) {
      // On disk but not in the registry: a pack that failed to load, or somebody's files. Overwriting would destroy
      // whatever is there — including a MEMORY.md that exists nowhere else — while looking like a fresh create; and
      // only a directory this call made is one it may remove again below.
      return {
        ok: false,
        error: `agents/${id}/ already exists on disk but did not load. Fix or remove it first.`,
      };
    }

    const displayName = input.displayName.trim() || id;
    const orchestrator = this.deps.config.daemon.orchestrator ? this.deps.registry.get(this.deps.config.daemon.orchestrator) : undefined;
    const fallback = input.external && !input.model.trim() ? externalAgentLlm(this.deps.config.llm.defaults, orchestrator?.config.llm) : null;
    const model = input.model.trim() || (fallback?.model ?? "");
    if (!model) return { ok: false, error: input.external ? "A model is required: the install has no default model, and its orchestrator none, for Nouride's own work for it." : "A model is required." };

    const withoutShell = input.allowExec === false ? SHELL_TOOLS : new Set<string>();
    // Checked before anything is written: a headline too long is a form to correct, not a pack half made.
    const headline = input.headline?.trim() ? cleanHeadline(input.headline) : null;
    if (input.headline?.trim() && !headline) return { ok: false, error: `A headline is one short line, ${HEADLINE_MAX} characters at most.` };
    const preset = presetOf(input.preset ?? "nourider");
    const tools = toolsFor(preset.id, this.availableTools(), input.tools).filter((name) => !withoutShell.has(name));
    /**
     * Every tool, written as `"*"`: this one and every one a later release adds. A list spelled out here
     * froze the agent at the release it was set up on — a box made before `skill_search` existed never
     * had it, and nothing said so. Only when nothing was held back: no terminal is a real list.
     */
    const written = preset.tools === "all" && withoutShell.size === 0 ? ["*"] : tools;

    const profile = input.provider?.trim() || fallback?.provider || this.usableProfile();
    if (!profile) {
      return {
        ok: false,
        error: "No provider profile has a usable credential yet. Configure one first.",
      };
    }
    if (!this.deps.providers.names().includes(profile)) {
      return {
        ok: false,
        error: `Provider profile "${profile}" is not configured. Available: ${this.deps.providers
          .names()
          .join(", ")}.`,
      };
    }

    await writeTextFileAtomic(
      join(dir, "IDENTITY.md"),
      ["# IDENTITY", "", `- **Name:** ${displayName}`, `- **Headline:** ${headline ?? preset.headline}`, ""].join("\n"),
    );

    await writeTextFileAtomic(
      join(dir, "SOUL.md"),
      `${underHeading("SOUL", input.systemPrompt.trim() || preset.soul)}\n`,
    );

    /**
     * The two persona slots that were never scaffolded.
     *
     * A pack that ships with only `IDENTITY.md` and `SOUL.md` looks like a runtime that supports only
     * those two — the loader reads five, but a slot with no file is indistinguishable from a slot that
     * does not exist. The operator who noticed had been running an agent for weeks without knowing
     * `AGENTS.md` was read at all.
     *
     * So both are written with real starting content rather than left empty. `AGENTS.md` in particular
     * earns it: the prompt marks it essential and never trims it, so an empty one costs nothing and a
     * filled one is the difference between an agent that asks before it acts and one that does not.
     */
    await writeTextFileAtomic(join(dir, "AGENTS.md"), preset.guidance ? `${STARTER_AGENTS.trimEnd()}\n\n## How you work\n\n${preset.guidance}\n` : STARTER_AGENTS);
    await writeTextFileAtomic(join(dir, "MEMORY.md"), STARTER_MEMORY);
    // Not loaded by anything: orientation for whoever edits this pack, at no cost in the prompt.
    await writeTextFileAtomic(join(dir, "README.md"), STARTER_README);

    // Not through `editPackFile`: a new pack, written whole — and removed whole when it does not load.
    await writeTextFileAtomic(
      join(dir, "config.toml"),
      [
        "# Created by the setup wizard. Hand-edit freely: this is config-as-code.",
        "",
        "[agent]",
        `display_name = ${JSON.stringify(displayName)}`,
        "enabled = true",
        "# Runs on its own and asks only before what is destructive, touches the system, infrastructure or",
        "# credentials, for everyone who talks to it, rather than following each person's own setting.",
        'approvals = "balanced"',
        "",
        "[llm]",
        `provider = ${JSON.stringify(profile)}`,
        `model = ${JSON.stringify(model)}`,
        "",
        "[tools]",
        ...(written[0] === "*"
          ? ["# Every tool, including ones a later release adds. List names instead to hold some back."]
          : ["# Written out in full rather than left to the default, so what this agent may do is visible", "# here rather than in the loader. Removing a name takes the capability away."]),
        `enabled = ${JSON.stringify(written)}`,
        "",
        ...lookLines(preset.look),
        ...(input.external
          ? [
              "# Its turns are answered by this coding CLI, run as this agent, signed in on this profile (the Brain tab).",
              "[external]",
              `cli = ${JSON.stringify(input.external.cli)}`,
              ...(input.external.profile?.trim() ? [`profile = ${JSON.stringify(input.external.profile.trim())}`] : []),
              "",
            ]
          : []),
      ].join("\n"),
    );

    try {
      await this.deps.registry.reload(id);
      if (input.autoOn || input.autoOn === undefined) {
        this.deps.autoApprove?.enable(LOCAL_GATEWAY_ID, TERMINAL_SENDER, input.actor);
        this.deps.autoApprove?.enable("web", TERMINAL_SENDER, input.actor);
      }
    } catch (err) {
      // Remove what this call just wrote. The guard above protects a pack with history in it; a pack
      // created three lines ago has none, and leaving it behind makes the *next* attempt fail with
      // "already exists on disk" — so one bug in here would lock the operator out of the id they
      // wanted, on a screen with no other way forward.
      removePath(dir);
      return {
        ok: false,
        error: `agents/${id}/ did not load, so nothing was kept: ${String(
          err instanceof Error ? err.message : err,
        )}`,
      };
    }

    // The first agent becomes the orchestrator, so a message with no mention reaches somebody — and, this being a new
    // install, groups ask for a mention: written out, so the file says what the daemon does (0.7.18). An install that
    // never set it keeps reading it as off. Written to the config file, and live with it, or a restart would forget it.
    // Never an external agent: Nouride's gate does not reach its CLI's own commands (`externalOrchestratorRefusal`).
    if (!this.deps.config.daemon.orchestrator && !input.external) {
      const saved = await editDaemonConfig(this.configPath(), this.deps.config, (existing) => {
        const named = namingOrchestrator(existing, id);
        const agents = (parseToml(named) as Record<string, unknown>).agents;
        const unset = !(typeof agents === "object" && agents !== null && "groups_require_mention" in agents);
        return unset ? upsertTomlTable(named, "agents", { groups_require_mention: true }) : named;
      });
      // The agent is made and loads; only its being the orchestrator did not stick, which a message with no mention shows.
      if (!saved.ok) log.warn("the first agent could not be made the orchestrator", { agent_id: id, error: saved.error });
    }

    log.info("agent created", { agent_id: id, provider: profile, model, actor: input.actor });
    this.deps.audit?.record({
      action: "agent_created",
      agentId: id,
      actor: input.actor,
      details: { display_name: displayName, model, provider: profile, tools },
    });

    return { ok: true, id, provider: profile };
  }
}
