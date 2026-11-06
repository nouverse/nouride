/** Agent persona, config, and session shapes — §4, §6.4, §13 SPEC, TD-008. */

import type { LlmEffort } from "./llm.ts";
import type { AgentLook } from "./look.ts";

/**
 * The markdown files that make up an identity, and the pack's files the prompt is built from. All
 * optional except IDENTITY. `USER.md` was a fifth until 0.7.0: one description of "the user", read on
 * every turn whoever was speaking. Who somebody is lives in People now, said only when
 * they are the one speaking; how an agent behaves lives in SOUL.md and AGENTS.md.
 */
export interface PersonaFiles {
  identity: string;
  soul?: string;
  agents?: string;
  memory?: string;
}

export interface Skill {
  name: string;
  /** From the SKILL.md frontmatter — this is what the model matches against. */
  description: string;
  /** Full SKILL.md body, loaded on demand rather than at boot. */
  path: string;
  /**
   * The agent that wrote it, from the frontmatter. **Absent means a person did.**
   *
   * This is the ownership signal, and it is derived rather than declared because it already exists:
   * everything the daemon's own pipeline writes stamps `author:` — `skill_create` with the calling
   * agent, an approved draft with the drafting one. A skill somebody added by hand has no such line
   * and never gains one.
   *
   * What it decides: the reflection loop may propose *improvements* to a skill an agent wrote, and
   * may not touch one a person wrote. Before the loop could update anything this distinction did not
   * exist; the moment it could, overwriting somebody's hand-written file became possible, and this is
   * what stops it. Hermes reaches the same rule through explicit ownership classes and a `pin`
   * command; ours falls out of a field that was already there.
   */
  author?: string;
  /**
   * The agents it is on for, from `agents:` in the frontmatter; absent is everyone.
   *
   * A skill the reflection pass writes is on for the agent whose work it came from. Every skill in the pool used to be
   * on for every agent, so one agent's procedure for its own job sat in six prompts — and a line drawn per agent in
   * `skills.toml` leaked again with each new skill. An agent's own `skills.toml` still wins either way.
   */
  agents?: string[];
  /**
   * Nouride tools the procedure calls — `exec`, `send_file`, `web_search`.
   *
   * The second axis of "can this host actually run it", and the one that was missing. `requires`
   * names programs on the machine; this names capabilities of the *agent*, which are a different
   * thing decided in a different file (`[tools] enabled` in the pack). A skill that shells out is
   * useless to an agent without `exec`, and until this existed nothing anywhere said so — the agent
   * read the skill, tried, and failed partway through with nothing for an operator to have seen
   * beforehand.
   *
   * Advisory, exactly like `requires`. The skill still loads and is still offered: hiding it would
   * make an agent silently unable to do something, with nothing to read (invariant 5).
   */
  needsTools?: string[];
  /**
   * Where the skill came from, and how it got here.
   *
   * - `shared` — `agents/skills/`, the one pool every agent draws from. **On for everybody unless
   *   switched off** in `agents/<id>/skills.toml`. There used to be a fourth scope, `local`
   *   (`agents/<id>/skills/`), and killing it is the point: a skill that lived in one agent's folder
   *   was invisible to the others, so the same procedure got re-derived and re-written per agent.
   * - `project` — `<root>/.agents/skills/` under a directory named in `[workspace] skill_roots`.
   *   Named explicitly rather than discovered: a skill is instructions in the *system* prompt, so
   *   anyone who can write into that repo can write into the agent's most trusted context.
   *   Auto-loading from every reachable directory would make a pull request a prompt-injection
   *   vector.
   * - `builtin` — ships with the daemon, from `skills/` in a checkout or beside the executable in an
   *   install. Same default as `shared` and the same switch; the difference is only who maintains
   *   the file — upgrading Nouride replaces a built-in one and never touches the pool.
   *
   * Precedence when two scopes use one name, highest first: `shared`, `builtin`, `project`. The
   * operator's pool beats what ships; what ships beats what a working directory offers.
   */
  scope: "shared" | "project" | "builtin";
  /**
   * Host software this skill's procedure needs, from the `requires:` frontmatter field.
   *
   * Advisory, never a gate. A skill whose `dot` is missing still loads and still says what it wanted
   * — hiding it would answer "why doesn't it know how to do that" with silence. The Skills Workshop
   * and `nouride doctor` probe these names against `PATH` and say which are absent.
   */
  requires?: string[];
}

/** A provider profile and a model on it, together: a model's name alone means nothing on another provider. */
export interface FallbackPair {
  provider: string;
  model: string;
}

export interface AgentLLMConfig {
  /**
   * Name of a `[providers.*]` profile in the daemon config.
   *
   * Not a vendor and not a URL: the endpoint, protocol and credential are all properties of
   * the profile, so switching an agent between two deployments is a one-word change here.
   */
  provider: string;
  model: string;
  /**
   * This pack's own `small_model` and `high_model` — the tiers its work may run on (`types/tiers.ts`). Absent inherits
   * the install's while it runs on the install's provider, else `model`: resolved where it is used, as the budgets
   * below are, so a change to the install's applies without reloading every pack.
   */
  smallModel?: string;
  highModel?: string;
  /** Output per reply; 0 is "by model" — the engine's `outputCap` picks the model's own figure. */
  maxTokens: number;
  temperature: number;
  /** How long a thinking model thinks (`LLM_EFFORTS`) — `[llm] effort`, else `[llm.defaults] effort`, else the provider's. */
  effort?: LlmEffort;
  /**
   * This model's real context window, when the operator knows it and the built-in table does not.
   *
   * The escape hatch for a proxy that renames models. `packages/llm` matches a model id against a
   * pattern list and falls back to a conservative default, which is the right shape for a library
   * that cannot know every model — but the fallback is *four times too small* for a current
   * long-context model, and the symptom is not an error. It is an agent whose tool output is trimmed
   * on every iteration, re-reading the file it just read, and a turn that ends with no reply. That
   * cost a live evening before the fallback was even made loud.
   *
   * Declared here rather than guessed there: this is the one place a person who knows the number can
   * write it down. Unset means the table decides.
   */
  contextWindow?: number;
  /**
   * Who answers when this agent's model cannot, in order — each a provider profile and a model on it (SMART_AUTOMATION
   * §3.1, which replaced 0.7's `fallback_model`). Tried after the provider's own retries: rate limited, overloaded, not
   * served — and, on another profile, down, out of credit or refusing its key, which another endpoint is not.
   *
   * A turn that falls back stays on that pair for the rest of the turn — the model that refused would be asked again
   * every round. Unset or empty means no fallback: the turn ends with what the provider said.
   */
  fallbacks?: FallbackPair[];
  /**
   * Context this agent carries before compacting, in tokens — the whole request, prompt and tools
   * included. Beats `[llm.context] compact_at_tokens` and the model's own default.
   *
   * Per agent because the right number is about the agent's work as much as its model: one doing long
   * jobs on a cheap, well-cached model can carry more than one answering a busy group chat.
   */
  compactAtTokens?: number;
  /**
   * Tool round-trips this agent's turns may take, overriding `[llm.limits] max_tool_iterations`.
   *
   * Unset means the daemon's number, and that is the point of it being optional: one agent doing
   * long refactors can be given room without giving it to the one answering questions in a group
   * chat, where a runaway turn is both expensive and slow to notice.
   *
   * Same bounds as the global setting — 5 to 9999, with 50 to 250 the range that works. See
   * `toolIterationsRefusal` in `types/config.ts`, which is the one place those numbers live.
   */
  maxToolIterations?: number;
  /**
   * This agent's own wall clock for one reply, in milliseconds. Absent follows the daemon.
   *
   * The other half of the pair, and it is a different question from the round-trip cap rather than
   * a restatement of it: an agent can burn its clock waiting inside three calls, or burn its
   * round-trips on twenty that each return instantly. A research agent that polls needs seconds; one
   * that reads and edits files needs iterations.
   *
   * Same bounds as the global setting — 30 to 3600 seconds. See `turnSecondsRefusal` in
   * `types/config.ts`, which is the one place those numbers live.
   */
  maxTurnDurationMs?: number;
}

/**
 * Chats this agent answers in, keyed by gateway instance id (`telegram:nouva`).
 *
 * Keyed by instance rather than by platform because two bots on the same platform are two
 * different audiences — chat id `12345` on one bot has nothing to do with `12345` on
 * another.
 */
export type AgentChannelBindings = Record<string, string[]>;

export interface AgentToolConfig {
  enabled: string[];
  approvalRequired: string[];
  /**
   * True when the pack wrote `approval_required` itself — which `droppedApprovalGates` reads: the loader seeds the list
   * with the mutating tools when a pack is silent, and only a list the pack wrote can have narrowed it.
   */
  approvalRequiredExplicit?: boolean;
  /**
   * The pack says `enabled = ["*"]`: every built-in tool this daemon has, and every one a later release
   * adds. `enabled` holds them spelled out, so nothing that reads it needs to know about the star.
   */
  everyTool?: boolean;
  /** Command patterns refused outright, before the approval gate is even reached. */
  blocked: string[];
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * A stdio server's environment variables that hold a credential: variable → the **name** of the secret (0.7.19).
   *
   * `env` is a table of literal values in a file people commit, and a stdio server takes its key there more often than
   * anywhere — `GITHUB_TOKEN`, `APIFY_TOKEN`. Resolved from the secret store when the server is started, the same rule
   * `authSecret` follows for an http server; a secret that is not set stops the start with its name.
   */
  envSecrets?: Record<string, string>;
  /**
   * Working directory for a stdio server.
   *
   * Load-bearing more often than it looks: a server that resolves its own skills, prompts or data
   * relative to the process's cwd finds nothing when the daemon starts it from the install root. The
   * transport has always supported it; nothing read it from config, so setting it did nothing.
   */
  cwd?: string;
  url?: string;

  /**
   * Extra headers for an HTTP transport. Literal values only — see `authSecret` for the credential.
   *
   * Refused at load if a value looks like a credential, the same check `assertSecretName` makes on
   * the other side. A token pasted here is a token in a file people commit, and the daemon would
   * work perfectly while it happened.
   */
  headers?: Record<string, string>;
  /**
   * The **name** of the secret holding this server's credential, never the credential.
   *
   * Same rule the gateways follow (`tokenSecret`): config references, the store resolves. Sent as
   * `Authorization: Bearer <value>` unless `authHeader` names somewhere else to put it.
   */
  authSecret?: string;
  /**
   * Where the credential goes, when it is not a bearer token.
   *
   * Set it to `X-Api-Key` and the resolved secret is sent raw under that header — no scheme prefix,
   * because the servers that want a custom header invariably want the bare key in it.
   */
  authHeader?: string;
  /**
   * `"oauth"`: a person logged this remote server in through its OAuth flow (0.7.19), and its tokens are in the secret
   * store — renewed by themselves, the pair written back together. Written by the login, never by hand: a remote server
   * with no credential of its own is tried without one, and one that asks for a login says so as "needs login".
   */
  auth?: "oauth";
  /**
   * Which of this server's tools may run at the same time as each other and the read-only built-ins.
   *
   * `true` is all of them, `false` none, and a list names them — `*` matches any run of characters,
   * against the server's own tool name. A list is the whole answer: a tool not on it runs alone
   * whatever the server claims. Absent, the server's `readOnlyHint` decides, and a tool without one
   * runs alone, which is what every MCP tool did before this existed.
   *
   * A tool that needs approval never runs alongside anything, whatever this says: the approval path
   * talks to one person about one call at a time.
   */
  parallelSafe?: boolean | string[];
  /**
   * In the install's library (`agents/mcp.toml`, 0.7.19): every agent switched on brings its own credential — its
   * `env_secrets`, `auth_secret` or login — rather than the library's. For an account that is one person's: an
   * agent switched on for someone else must not act as them.
   */
  perAgent?: boolean;
  /**
   * Which of the server's tools this agent gets, by the server's own names (0.7.21) — the `tools` list of the agent's
   * switch (`agents/<id>/mcp.toml`). Absent: every tool. A tool left out is not
   * sent to the model, and a call to it is refused. A server's whole tool list goes into every request the agent makes
   * (Notion's: about 250 KB), so leaving out what an agent never uses is the cheapest saving there is.
   */
  tools?: string[];
  /**
   * Whose login a remote server is reached with: `shared` — the one made for the library, for every agent that uses
   * it — or this agent's id, for a login of its own. Decided by the loader from the agent's `mcp.toml`; never
   * written in a file.
   */
  loginAs?: string;
}

/**
 * One agent's word on one of the library's MCP servers (`agents/<id>/mcp.toml`, 0.7.19): whether it is on, and the
 * credential this agent uses in place of the library's — secrets named, never their values.
 */
export interface AgentMcpChoice {
  on: boolean;
  /** Variables of a stdio server this agent sets itself: variable → secret name, over the library's. */
  envSecrets?: Record<string, string>;
  /** A remote server's credential, this agent's own: a secret's name. */
  authSecret?: string;
  /** `own`: this agent logs the server in itself, rather than using the library's login. */
  login?: "own";
  /** The server's tools this agent gets, by the server's names (0.7.21). Absent: all of them. */
  tools?: string[];
}

/**
 * How much gets asked before a gated tool call runs.
 *
 * Declared here rather than in `@nouride/policy` because `shared` imports nothing (§1 of the
 * dependency matrix) and `AgentConfig` needs it. The *rules* — who decides between the layers, and
 * what each level lets through — live in policy's `approvals.ts`, which imports these.
 */
export type ApprovalLevel = "careful" | "balanced" | "trusted";

/** What an agent may be set to. `per-person` means "do not decide here — follow the person". */
export type AgentApprovalLevel = ApprovalLevel | "per-person";

const APPROVAL_LEVELS: readonly ApprovalLevel[] = ["careful", "balanced", "trusted"];
const AGENT_APPROVAL_LEVELS: readonly AgentApprovalLevel[] = [...APPROVAL_LEVELS, "per-person"];

export function isAgentApprovalLevel(value: unknown): value is AgentApprovalLevel {
  return typeof value === "string" && (AGENT_APPROVAL_LEVELS as readonly string[]).includes(value);
}

/** Why `value` is not a level an agent may be set to — the list, for an old name (`risky`, until 0.7.23) as for a typo. */
export function approvalLevelRefusal(value: unknown): string {
  return `approvals must be one of ${AGENT_APPROVAL_LEVELS.join(", ")}, got ${JSON.stringify(value)}`;
}

/**
 * Whether this agent's connections take new senders: `pair` gives a stranger a pairing code, `allowlist`
 * drops them, `follow` (and absent) defers to `[security.access] mode`. Not `open` — that is refused
 * daemon-wide for any agent with `exec`, and a per-agent way round it would be a hole in that guard.
 */
export type AgentAccess = "follow" | "pair" | "allowlist";
export const AGENT_ACCESS: readonly AgentAccess[] = ["follow", "pair", "allowlist"];

export function isAgentAccess(value: unknown): value is AgentAccess {
  return typeof value === "string" && (AGENT_ACCESS as readonly string[]).includes(value);
}

/** One credential an agent's commands may receive, and which commands (`[security.exec_secrets]`, S6). */
export interface ExecSecret {
  /** Its name in the secret store; the variable is that name upper-cased. */
  name: string;
  /** Argv prefixes — `"twine upload"` — or `"*"`, every command, an interactive session included. */
  commands: string[];
}

/**
 * An external agent's preset (0.8.1, EXTERNAL_AGENTS §5.1), turned into its CLI's own modes: `folder` — free in its
 * folder, the operating system its wall; `risky` — asks for what is risky; `all` — asks for every tool call.
 */
export const EXTERNAL_PERMISSIONS = ["folder", "risky", "all"] as const;
export type ExternalPermissions = (typeof EXTERNAL_PERMISSIONS)[number];

/**
 * A coding CLI the person adds (`[[external_clis]]` in config.toml, 0.8.1), beside the two built in: what starts its
 * ACP mode, and what Nouride says and does around it. The shape of `@nouride/acp`'s `CliRow`, which it is used as.
 */
export interface ExternalCliConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  install: string;
  versionArgs: string[];
  profileEnv?: string;
  modes?: Partial<Record<ExternalPermissions, string>>;
  instructionFile: string;
  login?: string[];
  loginNote?: string;
  signedOut?: string[];
}

/** `[external]` in a pack: this agent's turns are answered by a coding CLI over the Agent Client Protocol (0.8.1). */
export interface ExternalAgentConfig {
  /** Which CLI: a built-in row's id (`claude-code`, `codex`) or one in `[[external_clis]]`. */
  cli: string;
  /** The profile — the CLI's sign-in and settings folder, inside the agent's own — it uses. Absent: `default`. */
  profile?: string;
  /** Passed to the CLI as its model. Absent: the CLI's own default. */
  model?: string;
  /** Absent: `folder` where each agent is its own user, `risky` where it is not (Docker, macOS). */
  permissions?: ExternalPermissions;
}

export interface AgentConfig {
  /**
   * `[external]` — a coding CLI answers this agent's turns, not a model through Nouride's profiles (0.8.1). The one fact
   * every place that runs a turn reads; nothing names a CLI. `llm` stays: it is the model of the work Nouride does for
   * the agent around its CLI — a mission's reviewer, the memory pass.
   */
  external?: ExternalAgentConfig;
  /** Its cat in Nouride Office, part by part (0.8.1): what `[look]` picks; the rest comes from its id. */
  look?: AgentLook;
  /** Whether a stranger messaging this agent's connections is paired or dropped. See `AgentAccess`. */
  access?: AgentAccess;

  /**
   * How much this agent asks, for everyone who talks to it. Absent or `per-person` defers.
   *
   * An agent is a shared surface — several people reach the same one — so a posture set here applies
   * to all of them. That is the difference from the per-person setting, and the reason this exists.
   * See `@nouride/policy`'s `approvals.ts`.
   */
  approvals?: AgentApprovalLevel;

  id: string;
  displayName: string;
  emoji?: string;
  enabled: boolean;
  llm: AgentLLMConfig;
  channels: AgentChannelBindings;
  tools: AgentToolConfig;
  /**
   * This agent's switch per skill, from `agents/<id>/skills.toml`. Absent from the map means **on**.
   *
   * A map of decisions rather than a list of names, and default-on rather than opt-in, for one
   * reason each:
   *
   * - **Default-on**, because an opt-in list cannot name a skill that does not exist yet. Every
   *   skill added later — by an operator, by an upgrade, by an agent writing one down — would arrive
   *   switched off on every install that had ever touched the list, with nothing to say why.
   * - **A map**, because `false` and *absent* have to be different things. The dashboard has to show
   *   "off" for a name whose directory is gone (a typo in the file, or a deleted skill) and an
   *   explicit `true` is the operator saying "I looked at this one" — a list of names can express
   *   neither.
   *
   * Not in `config.toml`: a toggle a human flips in a dashboard, an agent flips with `skill_toggle`,
   * and git diffs after a week does not belong in the same file as the model endpoint. Its own file
   * also means a write here can never corrupt the config that decides whether the agent boots.
   */
  skills: Record<string, boolean>;
  /**
   * The MCP servers this agent uses: the library's (`agents/mcp.toml`) it switched on, with its own credentials laid
   * over — and any its `config.toml` still declares itself, until the next start folds them into the library.
   */
  mcpServers: McpServerConfig[];
  /** `agents/<id>/mcp.toml`, as written: which library servers are on, and this agent's credentials for them. */
  mcp?: Record<string, AgentMcpChoice>;
  /** `[jobs] quiet_after_minutes`: this agent's own `JobsSection.quietAfterMinutes`. Absent follows it. */
  jobQuietAfterMinutes?: number;
  /** `[delegate] max_background`: this agent's own `DelegateSection.maxBackground`. Absent follows it. */
  maxBackgroundHelpers?: number;
  /** `[missions] per_agent`: how many missions this agent may have working at once, its own `MissionsSection.perAgent` (0.8.11). Absent follows it. */
  missionsPerAgent?: number;
  /**
   * Extra directories this agent may read and write, on top of its own.
   *
   * **Opt-in, not required.** Every agent gets `data/workspace/<id>/` derived at boot, so it can work
   * without any of this. Declare a root here to point it at something that already exists — a project
   * repo, a shared folder.
   *
   * `~` expands to home; a relative path resolves against the agent's own pack directory. A root that
   * does not exist is warned about at load and by `nouride doctor`, because otherwise every path inside
   * it is silently refused and that reads as the agent being broken.
   */
  workspaceRoots: string[];
  /** Empty means inherit the daemon-level allowlist. */
  senderAllowlist: string[];
  /**
   * Secret **names** this agent's `exec` may receive as environment variables.
   *
   * Names, never values (invariant 3) — the value is resolved from the secret store at the moment a
   * command runs and handed to the child process. It is never rendered into the prompt, a tool
   * result or the transcript, so the model can use a credential without ever seeing one.
   *
   * Opt-in per agent, because "which credentials may this agent spend" is exactly the question an
   * operator should have to answer deliberately. An empty list means the child gets the bare
   * environment allowlist and nothing else.
   *
   * Each bound to the commands that need it (S6): `[security.exec_secrets] pypi_token = ["twine upload"]`.
   */
  execSecrets: ExecSecret[];
  /**
   * `[security] ssh_agent = true` — this agent's commands and stdio MCP servers get the daemon's `SSH_AUTH_SOCK`.
   *
   * The socket signs with every key the ssh-agent holds, for whoever asks, so a command holding it can `git push` or
   * `ssh` to any host those keys open. Until 0.7.9 every command of every agent got it (S11); now an agent whose work
   * is reaching other machines says so here, and the others do not hold it. A key named in `~/.ssh/config` is a file,
   * not the socket, and is not affected. Absent and `false` both mean off; only `false` says the pack decided.
   */
  sshAgent?: boolean;
  /**
   * `[security] credentials = false` — this agent's commands do not read the credentials directory: its user is not in
   * `nr-creds` (0.8.0, where each agent's commands run as its own user). Absent is on, as it was for every agent before;
   * a pack that turns it off reaches no key, and `ssh` with one from there fails.
   */
  credentials?: boolean;
  /**
   * `[security] shared_tools = false` — the orchestrator stops installing and updating the programs every agent runs
   * (`nouride tools run`, 0.8.0). Absent is on; only the orchestrator (`[daemon] orchestrator`) ever has it, so in any
   * other agent's pack it changes nothing.
   */
  sharedTools?: boolean;
  /** `[security] model_guard` — the second look for this agent (0.8.0, `types/model-guard.ts`). Absent: the daemon's. */
  modelGuard?: string;
  /**
   * Directories whose `.agents/skills/` this agent loads, on top of its pack and the shared set.
   *
   * The point is the working loop: drop a `SKILL.md` into a project you are working on and the next
   * message already knows about it — no reload, the way a project's own instructions behave in an
   * editor-based agent.
   *
   * Explicit rather than "every workspace root", and that is the whole safety story. A root is
   * somewhere the agent may read and write; a skill root is somewhere it accepts *instructions*
   * from. A repository cloned yesterday should be the first without being the second.
   */
  skillRoots: string[];
}

export interface LoadedAgent {
  config: AgentConfig;
  persona: PersonaFiles;
  skills: Skill[];
  /** Directory the agent was loaded from — also its tool workspace root. */
  dir: string;
  /** Newest mtime across persona files and config, for hot-reload detection. */
  loadedAt: number;
}

export type AgentRuntimeStatus = "running" | "paused" | "error";

export type SessionType = "main" | "subagent" | "cron" | "thread";

export interface SessionKey {
  agentId: string;
  chatId: string;
  /** Gateway *instance* id, so two bots on one platform keep separate conversations. */
  gatewayId: string;
}

export interface Session {
  id: string;
  agentId: string;
  chatId: string;
  gatewayId: string;
  sessionType: SessionType;
  status: "active" | "paused" | "expired";
  contextTokenCount: number;
  /** When the chat row was first created — survives `/new`, so it dates the chat, not the conversation. */
  createdAt: number;
  /** When the *current* conversation began. Reset by `/new`; this is what a rollover policy reads. */
  startedAt: number;
  updatedAt: number;
}
