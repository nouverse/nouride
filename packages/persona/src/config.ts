/**
 * Per-agent `config.toml` → typed `AgentConfig` — §4.2 SPEC.
 *
 * Mapped field by field rather than through the generic camelize-and-merge used for the
 * daemon config. The reason is who writes the file: an agent pack is edited by hand far
 * more often, so an unknown provider profile or a `max_tokens = "lots"` deserves a message
 * naming the file, the field and the accepted values — not a silently ignored key.
 */

import { assertSecretName, looksLikeCredential } from "@nouride/secrets";
import { externalOf } from "./external.ts";
import { lookOf } from "./look.ts";
import { fallbacksOf } from "./fallbacks.ts";
import {
  AGENT_ACCESS,
  isAgentAccess,
  isAgentApprovalLevel,
  isLlmEffort,
  LLM_EFFORTS,
  ConfigError,
  isModelTier,
  maxBackgroundRefusal,
  missionsPerAgentRefusal,
  modelGuardRefusal,
  approvalLevelRefusal,
  type AgentChannelBindings,
  type AgentConfig,
  type ExecSecret,
  type LLMDefaultsSection,
  type McpServerConfig,
  oneLine,
  toolIterationsRefusal,
  turnSecondsRefusal,
} from "@nouride/shared";

/**
 * Tools that were renamed, old name → new: `memory_recent` (until 0.6) and `task_plan` (until 0.7.16). 0.7.x rewrote
 * them in every pack; in 0.8.0 a list that names one is refused for that agent, naming the new name — read as nothing,
 * it would take memory search or the plan away without a word, and in `blocked` it would unblock the tool.
 */
const RENAMED_TOOLS: Readonly<Record<string, string>> = { memory_recent: "memory_search", task_plan: "plan" };

/**
 * Every built-in tool, by name — what `enabled = ["*"]` means.
 *
 * Here rather than asked of the tool registry, which is built after the packs load. Kept equal to what
 * the registry can build by the engine's `setup-tools.test.ts`, in both directions.
 */
export const BUILTIN_TOOLS: readonly string[] = [
  "read", "glob", "grep", "plan", "notes", "delegate",
  "write", "edit", "multi_edit",
  "web_fetch", "web_search",
  "memory_read", "memory_write", "memory_search", "memory_analyze",
  "person_record", "person_notes",
  "send_file", "send_message", "session_status",
  "attachment_read",
  "exec", "session", "secret_save",
  "nouride", "update",
  "skill_create", "skill_toggle", "skill_improve", "skill_search", "skill_install",
  "mcp_search",
  "agent_create", "agent_configure",
];

/**
 * `"*"` in `[tools] enabled`: every tool, now and in any later release.
 *
 * The setup wizard's first agent is written with it. A list spelled out at setup froze what that agent
 * could do at the release it was made on: a box set up before `skill_search` existed never had it, and
 * nothing said so. Other names beside the star are kept (an MCP tool, say); none is taken away.
 */
const EVERY_TOOL = "*";

function currentToolNames(names: string[], where: string): string[] {
  const renamed = names.filter((name) => name in RENAMED_TOOLS);
  if (renamed.length > 0) {
    throw new ConfigError(`${where} names ${renamed.map((name) => `${name} (renamed ${RENAMED_TOOLS[name]})`).join(", ")}: write the new name`);
  }
  return names;
}

export interface RawAgentConfig {
  agent?: {
    display_name?: unknown;
    emoji?: unknown;
    enabled?: unknown;
    approvals?: unknown;
    access?: unknown;
  };
  llm?: {
    provider?: unknown;
    model?: unknown;
    small_model?: unknown;
    high_model?: unknown;
    max_tokens?: unknown;
    temperature?: unknown;
    effort?: unknown;
    context_window?: unknown;
    fallback_model?: unknown;
    fallbacks?: unknown;
    compact_at_tokens?: unknown;
    max_tool_iterations?: unknown;
    max_turn_seconds?: unknown;
  };
  channels?: unknown;
  tools?: { enabled?: unknown; approval_required?: unknown; blocked?: unknown };
  security?: { sender_allowlist?: unknown; exec_secrets?: unknown; ssh_agent?: unknown; credentials?: unknown; shared_tools?: unknown; model_guard?: unknown };
  workspace?: { roots?: unknown; skill_roots?: unknown };
  mcp_servers?: unknown;
  external?: unknown;
  look?: unknown;
  jobs?: { quiet_after_minutes?: unknown };
  delegate?: { max_background?: unknown };
  missions?: { per_agent?: unknown };
}

export interface ParseAgentOptions {
  defaults: LLMDefaultsSection;
  /**
   * Provider profile names from the daemon config.
   *
   * Passed in so a typo — `provider = "anthropc"` — fails at load, next to the file that
   * caused it, instead of on the agent's first message hours later.
   */
  knownProviders?: string[];
  /** Gateway instance ids, for the same reason: catch a stale binding at load. */
  knownGateways?: string[];
  /** The coding CLIs an `[external]` pack may name (0.8.1): the built-in rows and the install's own. */
  knownClis?: string[];
}

/**
 * The read-only set a pack gets when it says nothing.
 *
 * `glob` and `grep` are in it because `read` alone is unusable: it needs a path, and without discovery
 * nothing can produce one. Observed live — an agent asked to look at its workspace answered that it had
 * only `read` and therefore could not find anything. Both are read-only and need no approval, so
 * including them widens what the agent can *see*, never what it can change.
 */
const DEFAULT_TOOLS = [
  "read",
  "glob",
  "grep",
  // Read-only in every sense that matters — it changes nothing outside the turn it belongs to — and
  // the work it helps with is exactly the work an agent gets wrong without it.
  "plan",
  // Read-only in itself: everything a helper then does is gated exactly as it would be in the
  // parent's own turn, so offering it widens nothing.
  "delegate",
  // The same argument, one step further out: what the other agent does is gated in *its* turn against
  // *its* permissions, so asking it something widens nothing either. Here by default because it is not
  // an optional nicety in a multi-agent install — it is the only way one agent reaches another in a
  // one-to-one chat, and a pack that does not name it would write @mentions into a DM that go nowhere.
  // Withdrawn per turn when the daemon has no other agent to ask; see `resolveToolset`.
  "ask_agent",
  "web_fetch",
  // Added once search stopped needing a credential.
  //
  // It was left out because without an API key the tool was not offered at all, so listing it would
  // have advertised something absent. That is no longer true — there is a keyless fallback — and the
  // gap had a cost: an agent asked to find a current price had no search tool, so it improvised, and
  // what it improvised was a `python3` scraper run through `exec`. Slower, needs an approval, and puts
  // a hand-written parser inside a shell command. Read-only, like the rest of this list.
  "web_search",
  "memory_read",
  "memory_write",
  // Read-only like the two above, and filtered by the chat it is called from. Offered only where the
  // daemon keeps memory; a pack that did not name it would never reach anything older than the few
  // conversations in the prompt.
  "memory_search",
  // Counts over the same conversations, for the questions a search answers badly ("how often", "when
  // did it come up"). Read-only and filtered the same way.
  "memory_analyze",
  /**
   * The other place a durable fact goes, and the one `memory_write` was being used for by mistake.
   *
   * Here rather than left to each pack, because the two are a pair: an agent holding `memory_write`
   * without this one has exactly one place to put a name it has just been told, and it is the wrong
   * place. Watched live — somebody introduced themselves on Telegram and the turn's only tool call
   * was `memory_write`, so the next conversation still opened not knowing them, because the identity
   * line is built from `[[people]]` and memory is never read for it.
   *
   * It grants nothing. `[[people]]` is identification and never authorisation — every sender gets the
   * same toolset whether they are named there or not — so this widens what the agent *remembers*,
   * not what anyone may do.
   */
  "person_record",
  // Its other half: what does not change about the person speaking, kept in their notes at their word —
  // theirs only. Without it, "I'm allergic to shrimp" has nowhere to go but memory.
  "person_notes",
  // Read-only in the only sense that matters here: it discloses nothing `read` does not, to nobody
  // `read` would not already have reached. The bytes go to the conversation the agent is already
  // speaking in, and an agent that wanted to leak the same file could paste it as text today,
  // ungated. What it changes is whether a 4000-line log arrives as a file or as an apology.
  "send_file",
  // Not read-only: it speaks to people outside the conversation. Here because a household's agent is asked to "tell
  // Mira" or "post it in the family group" as a matter of course — and without it, it digs the chat's id out of the
  // daemon's database and schedules a job to post it (0.7.23). Its own gate asks at the agent's approval level.
  "send_message",
  "session_status",
  /**
   * The daemon's own CLI — and the one entry here that is not a read.
   *
   * `exec` sat in this slot for one release, added so the prompt's CLI block would render at all: it
   * was gated on `installDir && toolNames.includes("exec")`, so a pack that said nothing about tools
   * could not see the daemon's control surface and reached for sqlite and OS-level tools instead.
   * That bought the CLI by handing every default agent a general shell, which was a much larger
   * concession than the problem needed — and it did not even work, because `resolveCwd` refuses the
   * install directory as a `cwd`.
   *
   * The `nouride` tool is what that was trying to be. `argv[0]` is fixed to this install's binary, so
   * an agent gets agents, gateways, approvals, grants, jobs, cron, webhooks, people, access, logs,
   * audit and config — and no way to run anything else. A shell is now an explicit choice again.
   *
   * Still gated: it forwards to `exec`'s decision, so `mode` / `ask` / `blocked` / the hardline
   * classes all apply, and it is on `DEFAULT_APPROVAL_REQUIRED` below. And still removable — a pack
   * that wants an agent with no reach into the daemon drops it, and the prompt's CLI section goes
   * with it rather than describing something it cannot call.
   */
  "nouride",
];

/**
 * Mutating tools are approval-gated unless the pack says otherwise (TD-010).
 *
 * The harness tools are here for the same reason as `exec`: they change what the daemon does
 * *after* the conversation ends — a new agent keeps existing, a provider switch survives the
 * turn — so a human should see them the first time.
 */
export const DEFAULT_APPROVAL_REQUIRED = [
  "exec",
  // Narrower than `exec` and gated the same way: it changes what the daemon does after the
  // conversation ends, so a human sees it the first time.
  "nouride",
  // Its own gate decides per action — starting a program and typing into one ask; reading does not.
  // Listed here so a pack that writes the list by hand does not silently lose that.
  "session",
  "write",
  "edit",
  "multi_edit",
  "agent_create",
  "agent_configure",
  "skill_create",
  "skill_toggle",
  "skill_improve",
];

export function parseAgentConfig(
  id: string,
  raw: RawAgentConfig | null,
  options: ParseAgentOptions,
): AgentConfig {
  const where = `agents/${id}/config.toml`;
  const agent = raw?.agent ?? {};
  const llm = raw?.llm ?? {};
  const { defaults } = options;

  const provider = str(llm.provider, `${where} [llm] provider`) ?? defaults.provider;
  if (options.knownProviders && !options.knownProviders.includes(provider)) {
    throw new ConfigError(
      `${where} [llm] provider "${provider}" is not a configured profile (known: ${options.knownProviders.join(", ")})`,
    );
  }

  return {
    id,
    ...externalOf(raw?.external, where, options.knownClis),
    ...lookOf(raw?.look, where),
    displayName: str(agent.display_name, `${where} [agent] display_name`) ?? titleCase(id),
    ...(str(agent.emoji, `${where} [agent] emoji`) ? { emoji: String(agent.emoji) } : {}),
    // Absent means enabled: a directory someone created is one they meant to use, and
    // `enabled = false` is the explicit way to park it.
    enabled: bool(agent.enabled, `${where} [agent] enabled`) ?? true,
    /**
     * `[agent] approvals` — how much this agent asks, for everyone who talks to it.
     *
     * Absent is *not* defaulted to `per-person` here. Absent has to stay distinguishable from a pack
     * that wrote `per-person` on purpose: the resolver treats them the same today, and a value written
     * in by the loader would make a future difference between them unexpressible — the same reason
     * `approvalRequiredExplicit` exists a few lines down.
     *
     * Validated at load with the file and the field in the message, so a typo is a boot error rather
     * than an agent that quietly asks more or less than intended (invariant 7).
     */
    ...(agent.approvals === undefined
      ? {}
      : {
          approvals: (() => {
            // An old name (`risky`, until 0.7.23) is refused like any other word: 0.7.x rewrote it in every pack.
            if (!isAgentApprovalLevel(agent.approvals)) throw new ConfigError(`${where} [agent] ${approvalLevelRefusal(agent.approvals)}`);
            return agent.approvals;
          })(),
        }),
    // `[agent] access` — the same shape as `approvals` above: absent stays absent, a bad value fails at load.
    ...(agent.access === undefined
      ? {}
      : {
          access: (() => {
            if (!isAgentAccess(agent.access)) {
              throw new ConfigError(`${where} [agent] access must be one of ${AGENT_ACCESS.join(", ")}, got ${JSON.stringify(agent.access)}`);
            }
            return agent.access;
          })(),
        }),
    llm: {
      provider,
      model: str(llm.model, `${where} [llm] model`) ?? defaults.model,
      // Absent stays absent: the install's tier is resolved where it is used (`tierModel`), so changing it reaches
      // every agent that did not name its own.
      ...tierKey(llm.small_model, `${where} [llm] small_model`, "smallModel"),
      ...tierKey(llm.high_model, `${where} [llm] high_model`, "highModel"),
      maxTokens: num(llm.max_tokens, `${where} [llm] max_tokens`) ?? defaults.maxTokens,
      temperature: num(llm.temperature, `${where} [llm] temperature`) ?? defaults.temperature,
      // Refused at load when it is not a level: every request this agent makes would carry it, and fail.
      ...(() => {
        if (llm.effort === undefined) return defaults.effort ? { effort: defaults.effort } : {};
        if (!isLlmEffort(llm.effort)) {
          throw new ConfigError(`${where} [llm] effort must be one of ${LLM_EFFORTS.join(", ")}, got ${JSON.stringify(llm.effort)}`);
        }
        return { effort: llm.effort };
      })(),
      // No default: absent has to stay distinguishable from "declared", because the fallback lives in
      // `packages/llm` and a number invented here would hide the very miss this exists to fix.
      ...(() => {
        const declared = num(llm.context_window, `${where} [llm] context_window`);
        if (declared === undefined) return {};
        if (!Number.isInteger(declared) || declared < 1024) {
          throw new ConfigError(
            `${where} [llm] context_window must be a whole number of at least 1024, got ${declared}`,
          );
        }
        return { contextWindow: declared };
      })(),
      // Absent stays absent: no fallback is the behaviour every pack had before there was one.
      ...fallbacksOf(llm, where, provider, str(llm.model, `${where} [llm] model`) ?? defaults.model, defaults, options.knownProviders),
      ...(() => {
        const declared = num(llm.compact_at_tokens, `${where} [llm] compact_at_tokens`);
        if (declared === undefined) return {};
        if (!Number.isInteger(declared) || declared < 16_000) {
          throw new ConfigError(
            `${where} [llm] compact_at_tokens must be a whole number of at least 16000 (it is the whole ` +
              `request, prompt and tools included), got ${declared}`,
          );
        }
        return { compactAtTokens: declared };
      })(),
      /**
       * Absent stays absent, for the same reason `context_window` does: the fallback is the
       * daemon's setting, and writing a number here would freeze this agent at whatever the global
       * happened to be the day the pack was parsed.
       */
      ...(() => {
        const declared = num(llm.max_tool_iterations, `${where} [llm] max_tool_iterations`);
        if (declared === undefined) return {};
        const refusal = toolIterationsRefusal(declared, `${where} [llm] max_tool_iterations`);
        if (refusal) throw new ConfigError(refusal);
        return { maxToolIterations: declared };
      })(),
      /**
       * Written in **seconds** and stored in milliseconds.
       *
       * The daemon's own key is `max_turn_duration_ms`, which is the right unit for a field that
       * sits beside other `_ms` timeouts in a file an operator reads once. A pack is edited far more
       * often and usually by somebody answering "how long may this agent take?" — and the honest
       * answer to that is "five minutes", not "300000".
       */
      ...(() => {
        const declared = num(llm.max_turn_seconds, `${where} [llm] max_turn_seconds`);
        if (declared === undefined) return {};
        const refusal = turnSecondsRefusal(declared, `${where} [llm] max_turn_seconds`);
        if (refusal) throw new ConfigError(refusal);
        return { maxTurnDurationMs: declared * 1000 };
      })(),
    },
    channels: parseChannels(raw?.channels, where, options.knownGateways),
    tools: {
      enabled:
        raw?.tools?.enabled === undefined
          ? [...DEFAULT_TOOLS]
          : (() => {
              const listed = currentToolNames(strArray(raw.tools.enabled, `${where} [tools] enabled`), `${where} [tools] enabled`);
              return listed.includes(EVERY_TOOL) ? [...new Set([...BUILTIN_TOOLS, ...listed.filter((name) => name !== EVERY_TOOL)])] : listed;
            })(),
      ...(raw?.tools?.enabled !== undefined && strArray(raw.tools.enabled, `${where} [tools] enabled`).includes(EVERY_TOOL) ? { everyTool: true } : {}),
      approvalRequired:
        raw?.tools?.approval_required === undefined
          ? [...DEFAULT_APPROVAL_REQUIRED]
          : currentToolNames(strArray(raw.tools.approval_required, `${where} [tools] approval_required`), `${where} [tools] approval_required`),
      // Whether the pack *said so*, as opposed to inheriting the default: a pack that wrote a narrower list than the
      // default is warned about (`droppedApprovalGates`), and one that wrote nothing is not.
      approvalRequiredExplicit: raw?.tools?.approval_required !== undefined,
      blocked: currentToolNames(strArray(raw?.tools?.blocked, `${where} [tools] blocked`), `${where} [tools] blocked`),
    },
    // Filled by the loader from `agents/<id>/skills.toml`, which is the only place skills are
    // switched. Nothing about them lives in `config.toml` — see `AgentConfig.skills`.
    skills: {},
    // A pack's own servers moved into the install's library in 0.7.19, and every start until 0.7.28 folded a block back
    // into it; 0.8.0 refuses one — a pack pulled from git may bring it back — naming where it goes.
    mcpServers: (() => {
      if (raw?.mcp_servers !== undefined) {
        throw new ConfigError(
          `${where} [[mcp_servers]] is gone from packs since 0.7.19. The server belongs in the install's library, agents/mcp.toml: ` +
            "add it with `nouride mcp add` or the dashboard's MCP page, switched on for this agent, and remove the block",
        );
      }
      return [];
    })(),
    ...(() => {
      const declared = num(raw?.jobs?.quiet_after_minutes, `${where} [jobs] quiet_after_minutes`);
      if (declared === undefined) return {};
      if (declared < 0) throw new ConfigError(`${where} [jobs] quiet_after_minutes must be 0 (off) or more, got ${declared}`);
      return { jobQuietAfterMinutes: declared };
    })(),
    // Absent follows the daemon's `[delegate] max_background`, like the turn budget: a number written here would stop
    // tracking the daemon's the day somebody moves it.
    ...(() => {
      const declared = num(raw?.delegate?.max_background, `${where} [delegate] max_background`);
      if (declared === undefined) return {};
      const refusal = maxBackgroundRefusal(declared, `${where} [delegate] max_background`);
      if (refusal) throw new ConfigError(refusal);
      return { maxBackgroundHelpers: declared };
    })(),
    // Missions it may have working at once (0.8.11): absent follows the daemon's `[missions] per_agent`, for the same
    // reason. The owner asked for three or four, set per agent, and the setting was the box's alone.
    ...(() => {
      const declared = num(raw?.missions?.per_agent, `${where} [missions] per_agent`);
      if (declared === undefined) return {};
      const refusal = missionsPerAgentRefusal(declared, `${where} [missions] per_agent`);
      if (refusal) throw new ConfigError(refusal);
      return { missionsPerAgent: declared };
    })(),
    workspaceRoots: strArray(raw?.workspace?.roots, `${where} [workspace] roots`),
    skillRoots: strArray(raw?.workspace?.skill_roots, `${where} [workspace] skill_roots`),
    senderAllowlist: strArray(
      raw?.security?.sender_allowlist,
      `${where} [security] sender_allowlist`,
    ),
    // Names only, and not checked against the secret store here: credentials resolve when they are used, not
    // when a pack loads. A name that is not stored — or not a valid secret name — never resolves, and
    // `childEnvFor` (`apps/engine/src/boot/child-env.ts`) logs a warning naming the secret each time a command would have got it.
    execSecrets: execSecrets(raw?.security?.exec_secrets, `${where} [security] exec_secrets`),
    // Absent stays absent, as `approvals` does: both mean off, but only a pack that said `false` has decided — and
    // the boot note about the socket an upgrade took away is for the packs that have not (S11).
    ...(() => {
      const declared = bool(raw?.security?.ssh_agent, `${where} [security] ssh_agent`);
      return declared === undefined ? {} : { sshAgent: declared };
    })(),
    ...(() => {
      const declared = bool(raw?.security?.credentials, `${where} [security] credentials`);
      return declared === undefined ? {} : { credentials: declared };
    })(),
    ...(() => {
      const declared = bool(raw?.security?.shared_tools, `${where} [security] shared_tools`);
      return declared === undefined ? {} : { sharedTools: declared };
    })(),
    // The second look for this agent (0.8.0): absent is the daemon's setting; empty is said to be unset there too.
    ...(() => {
      const declared = raw?.security?.model_guard;
      const refusal = modelGuardRefusal(declared);
      if (refusal) throw new ConfigError(`${where} [security] model_guard ${refusal}`);
      return typeof declared === "string" && declared.trim() ? { modelGuard: declared.trim() } : {};
    })(),
  };
}

/**
 * `[channels]` maps a gateway instance id to the chats the agent answers in, each the chat id the
 * platform reports — a Discord channel's own id, not anything with the guild in it. The router
 * compares them exactly (`router/index.ts`), so any other shape never matches:
 *
 *     [channels]
 *     "telegram:nouva" = ["-1001234567"]
 *     "discord:main"   = ["1234567890123456789"]
 */
function parseChannels(
  raw: unknown,
  where: string,
  knownGateways?: string[],
): AgentChannelBindings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} [channels] must be a table of gateway id → chat ids`);
  }

  const bindings: AgentChannelBindings = {};
  for (const [gatewayId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!gatewayId.includes(":")) {
      throw new ConfigError(
        `${where} [channels] key "${gatewayId}" must be a gateway instance id like "telegram:nouva"`,
      );
    }
    if (knownGateways && !knownGateways.includes(gatewayId)) {
      throw new ConfigError(
        `${where} [channels] "${gatewayId}" is not a configured gateway (known: ${knownGateways.join(", ") || "none"})`,
      );
    }
    bindings[gatewayId] = strArray(value, `${where} [channels] "${gatewayId}"`);
  }

  return bindings;
}

/**
 * `[llm] small_model` / `high_model` — this agent's model for that tier (`types/tiers.ts`), refused at load when it is
 * empty or names a tier rather than a model: either would be sent to the provider as a model id at the first piece of
 * work that asked for the tier.
 */
function tierKey<K extends "smallModel" | "highModel">(value: unknown, where: string, key: K): { [P in K]?: string } {
  const declared = str(value, where)?.trim();
  if (declared === undefined) return {};
  if (!declared) throw new ConfigError(`${where} is empty: name a model, or leave the key out to inherit the install's`);
  if (isModelTier(declared)) throw new ConfigError(`${where} = "${declared}" names a tier, where a model belongs: the one this tier runs on`);
  return { [key]: declared } as { [P in K]?: string };
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function str(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ConfigError(`${where} must be a string`);
  return value;
}

function num(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ConfigError(`${where} must be a number`);
  }
  return value;
}

function bool(value: unknown, where: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ConfigError(`${where} must be true or false`);
  return value;
}

/**
 * `[security] exec_secrets`: a table binding each secret to the commands that need it (S6). A command is an argv prefix
 * written as the command line starts — `"twine upload"` — or `"*"`, and `*` beside anything else is a mistake about what
 * it means, refused here rather than read as either. The list it was until 0.7.4 — every command — 0.7.22 rewrote as
 * the table with `"*"`; 0.8.0 refuses it, naming that form.
 */
function execSecrets(value: unknown, where: string): ExecSecret[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    throw new ConfigError(
      `${where} is a list, the form before 0.7.4. Write it as a table: [security.exec_secrets] with NAME = ["the command that needs it"], or ["*"] for every command`,
    );
  }
  if (typeof value !== "object") throw new ConfigError(`${where} must be a table of secret = ["command", …]`);
  return Object.entries(value as Record<string, unknown>).map(([name, commands], index) => {
    // Named by position: if the key is a pasted credential, no part of it goes into the message.
    secretName(name, `${where} (entry ${index + 1})`);
    const list = strArray(commands, `${where}.${name}`).map((command) => oneLine(command));
    if (list.length === 0 || list.some((command) => command === "")) {
      throw new ConfigError(`${where}.${name} must name at least one command ("twine upload"), or "*" for every command`);
    }
    if (list.includes("*") && list.length > 1) throw new ConfigError(`${where}.${name}: "*" is every command already: leave it alone, or list commands instead`);
    return { name, commands: list };
  });
}

function strArray(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ConfigError(`${where} must be an array of strings`);
  }
  return value as string[];
}

/**
 * The MCP library's server blocks, `[[servers]]` in `agents/mcp.toml` (`mcp-library.ts`), each refused at load with its
 * entry named.
 */
export function parseMcpServers(value: unknown, where: string, block = "[[servers]]"): McpServerConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${where} ${block} must be a list`);

  /**
   * Where each name was first written, so a second server of that name is refused at load (G12).
   *
   * A server's tools are offered as `<name>__<tool>`, so two servers of one name offer tools of one name, and the
   * agent got whichever connected last — a different server's `search` on a different boot, and nothing said. The
   * same is true of a name that holds the separator or ends in its first half: `a` with a tool `b__c` and `a__b`
   * with a tool `c` are both `a__b__c`, and so are `a` with `_c` and `a_` with `c`.
   */
  const seen = new Map<string, number>();
  return value.map((entry, index) => {
    const at = `${where} ${block} #${index + 1}`;
    if (typeof entry !== "object" || entry === null) throw new ConfigError(`${at} must be a table`);
    const server = entry as Record<string, unknown>;

    const name = str(server.name, `${at} name`);
    if (!name) throw new ConfigError(`${at} needs a name`);
    const first = seen.get(name);
    if (first !== undefined) {
      throw new ConfigError(
        `${at} name "${name}" is #${first}'s already. Each server needs a name of its own, because its tools are ` +
          `offered as ${name}__<tool> and two servers' tools would take each other's names`,
      );
    }
    if (name.includes("__") || name.endsWith("_")) {
      throw new ConfigError(
        `${at} name "${name}" may not hold "__" or end in "_": "__" is what separates a server's name from its ` +
          `tools' (${name}__<tool>), and a name that holds it could give two servers' tools one name`,
      );
    }
    seen.set(name, index + 1);

    const transport = str(server.transport, `${at} transport`) ?? "stdio";
    if (transport !== "stdio" && transport !== "sse" && transport !== "streamable-http") {
      throw new ConfigError(`${at} transport must be stdio, sse or streamable-http`);
    }

    // Catching this here rather than at connect time means a typo in a pack surfaces at
    // load, next to the file it came from.
    if (transport === "stdio" && !server.command) {
      throw new ConfigError(`${at} transport "stdio" needs a command`);
    }
    if (transport !== "stdio" && !server.url) {
      throw new ConfigError(`${at} transport "${transport}" needs a url`);
    }

    return {
      name,
      transport,
      ...(server.command ? { command: str(server.command, `${at} command`)! } : {}),
      ...(server.args ? { args: strArray(server.args, `${at} args`) } : {}),
      ...(server.cwd ? { cwd: str(server.cwd, `${at} cwd`)! } : {}),
      ...(server.url ? { url: str(server.url, `${at} url`)! } : {}),
      ...(server.env && typeof server.env === "object"
        ? { env: server.env as Record<string, string> }
        : {}),
      ...(server.env_secrets === undefined ? {} : { envSecrets: envSecretTable(server.env_secrets, server.env, transport, at) }),
      ...(server.headers ? { headers: headerTable(server.headers, at) } : {}),
      // A name, refused here when it is a value — as `config.toml`'s are (invariant 3).
      ...(server.auth_secret ? { authSecret: secretName(str(server.auth_secret, `${at} auth_secret`)!, `${at} auth_secret`) } : {}),
      ...(server.auth_header ? { authHeader: str(server.auth_header, `${at} auth_header`)! } : {}),
      ...(server.auth === undefined ? {} : { auth: oauthLogin(server, transport, at) }),
      ...(server.parallel_safe === undefined ? {} : { parallelSafe: parallelSafe(server.parallel_safe, at) }),
      ...(server.per_agent === undefined ? {} : { perAgent: perAgent(server.per_agent, at) }),
      ...(server.tools === undefined ? {} : { tools: mcpToolList(server.tools, `${at} tools`) }),
    };
  });
}

/**
 * `auth = "oauth"` — a remote server a person logged in to (`McpServerConfig.auth`). Refused for a stdio server, which
 * has no HTTP to send a token over, and beside a credential of the server's own — `auth_secret`, or an `Authorization`
 * header — since two credentials for one request leave which one the server read to whichever was written last.
 */
function oauthLogin(server: Record<string, unknown>, transport: string, at: string): "oauth" {
  if (server.auth !== "oauth") throw new ConfigError(`${at} auth must be "oauth", the one way a server is logged in to, written by its login`);
  if (transport === "stdio") throw new ConfigError(`${at} auth = "oauth" is for a remote server: a stdio server has no HTTP to send a token over`);
  const header = typeof server.headers === "object" && server.headers !== null && Object.keys(server.headers).some((name) => name.toLowerCase() === "authorization");
  if (server.auth_secret || header) {
    throw new ConfigError(`${at} auth = "oauth" and ${server.auth_secret ? "auth_secret" : "an Authorization header"} are two credentials for one server: keep one`);
  }
  return "oauth";
}

/**
 * `env_secrets = { GITHUB_TOKEN = "github_token" }` — a stdio server's credential variables, each naming a secret.
 *
 * Refused for an http server, which has no environment to put them in (`auth_secret` is its way), for a variable that
 * is not a variable's name, for a value that looks like the credential itself (the reason the table exists), and for a
 * variable `env` sets too: two sources for one variable leaves which one the server got to whichever wrote last.
 */
function envSecretTable(value: unknown, env: unknown, transport: string, at: string): Record<string, string> {
  if (transport !== "stdio") throw new ConfigError(`${at} env_secrets is for a stdio server's environment; an http server's credential is auth_secret`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${at} env_secrets must be a table of VARIABLE = "secret_name"`);
  }
  const literal = typeof env === "object" && env !== null ? Object.keys(env) : [];
  const table: Record<string, string> = {};
  for (const [variable, name] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new ConfigError(`${at} env_secrets: "${variable}" is not an environment variable's name`);
    if (literal.includes(variable)) throw new ConfigError(`${at} ${variable} is set in both env and env_secrets: keep it in env_secrets`);
    table[variable] = secretName(str(name, `${at} env_secrets.${variable}`)!, `${at} env_secrets.${variable}`);
  }
  return table;
}

/** `per_agent = true` — see `McpServerConfig.perAgent`. */
function perAgent(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") throw new ConfigError(`${at} per_agent must be true or false`);
  return value;
}

/** A secret's name, refused when it is a value — for `agents/<id>/mcp.toml` (`mcp-library.ts`) as for this file. */
export function mcpSecretName(value: unknown, where: string): string {
  return secretName(str(value, where)!, where);
}

/**
 * `tools = ["notion-search", "notion-fetch"]` — the server's tools an agent gets, by the server's own names
 * (`McpServerConfig.tools`). A name the server does not have is not an error here: the list is checked against what the
 * server offers when it connects, and said then — a server that renamed a tool must not keep the agent from loading.
 */
export function mcpToolList(value: unknown, where: string): string[] {
  if (Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim() !== "")) return [...new Set(value as string[])];
  throw new ConfigError(`${where} must be a list of the server's tool names, e.g. tools = ["search", "fetch"], or left out for all of them`);
}

/** `parallel_safe = true | false | ["search_*", "get_issue"]`. See `McpServerConfig.parallelSafe`. */
function parallelSafe(value: unknown, at: string): boolean | string[] {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim() !== "")) {
    return value as string[];
  }
  throw new ConfigError(
    `${at} parallel_safe must be true, false, or a list of tool names (\`*\` matches anything), ` +
      `got ${JSON.stringify(value)}`,
  );
}

/**
 * `headers = { "X-Client" = "nouride" }` — a flat table of strings, and nothing that looks like a
 * credential.
 *
 * The refusal is the point. `headers` is the obvious place to paste a bearer token, and doing so
 * produces a daemon that works — while the token sits in a `config.toml` that gets committed,
 * copied into a backup, and pasted into an issue. `auth_secret` exists so there is somewhere right
 * to put it, so this says that rather than just saying no.
 */
function headerTable(value: unknown, at: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${at} headers must be a table of header name → string`);
  }

  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") {
      throw new ConfigError(`${at} headers "${name}" must be a string`);
    }
    if (looksLikeCredential(raw)) {
      throw new ConfigError(
        `${at} headers "${name}" looks like a credential: put it in the secret store and name it ` +
          `with auth_secret instead, so it is not sitting in a file that gets committed`,
      );
    }
    headers[name] = raw;
  }
  return headers;
}

/**
 * A secret's name, refused when it is a value — as every name in `config.toml` is (invariant 3).
 *
 * A pack held none of that: a key pasted as an `exec_secrets` name or an `auth_secret` loaded, and the engine then
 * logged it on every command and every connection attempt, as the name of the secret it could not find. The message
 * names the file and field, never the value.
 */
function secretName(name: string, where: string): string {
  try {
    assertSecretName(name, where);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  return name;
}
