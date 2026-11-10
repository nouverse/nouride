/**
 * Tool registry — which tools exist, and which of them a given agent may use.
 *
 * Two levels, and the distinction matters: the *registry* is everything the daemon can
 * do, the *toolset* is what one agent is offered. An agent never sees a definition for a
 * tool it cannot call, because a tool in the schema is a promise the model will try to
 * use.
 */

import type { McpCatalog } from "@/modules/mcp-registry/index.ts";
import type { LinkFor } from "@/modules/web/links.ts";
import { createMcpSearchTool } from "@/modules/tools/builtins/mcp-search.ts";
import {
  createLogger,
  type LoadedAgent,
  type GateAsk,
  type GateDecision,
  type SecuritySection,
  type Tool,
  type ToolContext,
  type ToolDefinition,
} from "@nouride/shared";
import { resolveWithin } from "@nouride/runtime";
import { toolGrantKey } from "@nouride/policy";
import { BUILTIN_TOOLS, DEFAULT_APPROVAL_REQUIRED } from "@nouride/persona";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { TransientSecrets } from "@nouride/secrets";
import { heldValues, type SecretKeeping } from "@/modules/tools/held-secrets.ts";
import { createSecretSaveTool } from "@/modules/tools/builtins/secret-save.ts";
import {
  commandEnv,
  createExecTool,
  findBlocked,
  normalizeCommand,
  resolveCwd,
  type ExecToolOptions,
} from "@/modules/tools/builtins/exec.ts";
import { createSessionTool } from "@/modules/tools/builtins/sessions.ts";
import { createDelegateTool, type DelegateToolOptions } from "@/modules/tools/builtins/delegate.ts";
import { createAskAgentTool, type AskAgentToolOptions } from "@/modules/tools/builtins/ask-agent.ts";
import { waitingForm, wrapBoth } from "@/modules/tools/builtins/wait-then-move.ts";
import { createReadTool, editTool, multiEditTool, writeTool } from "@/modules/tools/builtins/files.ts";
import { readImagesFrom } from "@/modules/tools/builtins/read-image.ts";
import { globTool, grepTool } from "@/modules/tools/builtins/search.ts";
import { createPlanTool } from "@/modules/tools/builtins/plan.ts";
import { createNotesTool } from "@/modules/tools/builtins/notes.ts";
import type { NotesPort } from "@/modules/notes/store.ts";
import {
  createAgentConfigureTool,
  createAgentCreateTool,
  type HarnessToolOptions,
} from "@/modules/tools/builtins/harness.ts";
import { createNourideCliTool } from "@/modules/tools/builtins/nouride-cli.ts";
import { createUpdateTool, type UpdateToolOptions } from "@/modules/tools/builtins/update.ts";
import { createPersonNotesTool, createPersonRecordTool } from "@/modules/tools/builtins/people.ts";
import type { PeopleWriteDeps } from "@/modules/config/settings/people.ts";
import {
  createMemoryReadTool,
  createMemoryWriteTool,
  type EarlierTurns,
  type MemoryToolsDeps,
} from "@/modules/tools/builtins/memory.ts";
import { createMemorySearchTool } from "@/modules/tools/builtins/memory-search.ts";
import { createMemoryAnalyzeTool } from "@/modules/tools/builtins/memory-analyze.ts";
import { createSkillCreateTool, createSkillToggleTool, type SkillToolOptions } from "@/modules/tools/builtins/skills.ts";
import { createSkillImproveTool } from "@/modules/tools/builtins/skill-improve.ts";
import type { ReflectionEngine } from "@/modules/reflection/index.ts";
import type { SkillHub } from "@/modules/skills-hub/index.ts";
import { createSkillHubTools } from "@/modules/tools/builtins/skill-hub.ts";
import { createWebFetchTool, createWebSearchTool, type WebToolOptions } from "@/modules/tools/builtins/web/index.ts";
import { createSendFileTool, type SendFileOptions } from "@/modules/tools/builtins/attach.ts";
import { createSendMessageTool, type SendMessageOptions } from "@/modules/tools/builtins/send-message.ts";
import { withSecretMask } from "@/modules/tools/secret-mask.ts";
import { audited } from "@/modules/tools/audited.ts";
import type { ChildEnv } from "@/modules/tools/exec-secrets.ts";
import type { MachineFacts } from "@/commons/machine.ts";
import {
  createAttachmentReadTool,
  type AttachmentReadOptions,
} from "@/modules/tools/builtins/attachment.ts";

const log = createLogger("tools.registry");

export interface SessionStatus {
  agent: string;
  model: string;
  provider: string;
  gateway: string;
  chatId: string;
  turns: number;
  contextTokens: number;
  toolNames: string[];
  /** When the current conversation began — reset by `/new` and the rollover. */
  startedAt?: number;
}

export interface ToolRegistryOptions extends ToolsetDeps {
  security: SecuritySection;
  web?: WebToolOptions;
  /** Supplies live session facts for `session_status`. */
  sessionStatus?: (ctx: { agentId: string; chatId: string; gatewayId: string }) => SessionStatus;
  /**
   * Runs a subagent. Absent means `delegate` is not offered.
   *
   * A function rather than the pipeline, for the same reason as `startJob`: a tool that could reach
   * the pipeline could reach everything the pipeline can.
   */
  runSubagent?: DelegateToolOptions["run"];
  /** Starts a helper in the background, as a job. Absent: `delegate` refuses `background` and runs in the foreground only. */
  startHelper?: DelegateToolOptions["background"];
  /**
   * Starts a helper in the foreground that moves to the background once it outlasts the wait, and how long that is. Absent:
   * a helper in the foreground is waited for to the end.
   */
  waitedHelper?: Pick<DelegateToolOptions, "start" | "waitMs">;
  /** A worktree for a writing helper of a mission in one (`delegate` `isolated`, 0.8.1). */
  isolateHelper?: DelegateToolOptions["isolate"];
  /**
   * Runs another agent behind the chat. Absent means `ask_agent` is not offered.
   *
   * Two closures rather than the registry and the pipeline, for the same reason `runSubagent` is one:
   * a tool holding either could reach every agent's conversations, not just ask one of them a
   * question.
   */
  askAgent?: AskAgentToolOptions;
  /**
   * Enables the self-management tools — creating agents, listing providers, reloading.
   *
   * Omitted in tests that do not need them, so a test's tool surface stays the small set it is
   * actually asserting on.
   */
  harness?: HarnessToolOptions & Pick<SkillToolOptions, "builtinSkillsDir" | "skillsOffGlobally">;
  /**
   * The self-improvement loop, for `skill_improve`.
   *
   * Absent means the tool is not offered at all rather than offered and broken — an agent told it
   * can propose a correction, whose proposal goes nowhere, is worse than one that was never told.
   */
  reflection?: ReflectionEngine;
  /** `skill_search` / `skill_install`. Absent means neither is offered. */
  skillHub?: SkillHub;
  /** `mcp_search`: Nouverse's MCP catalog, and where the dashboard is, for the link it gives. Absent: not offered. */
  mcpCatalog?: { catalog: McpCatalog; linkFor: LinkFor };
  /**
   * Enables `send_file`. Absent where there is no gateway to send through — a test harness, or a
   * one-shot tool run — and then the tool is not offered rather than offered and failing.
   */
  sendFile?: SendFileOptions;
  /** Enables `send_message`, for the same reason and in the same cases as `sendFile`. */
  sendMessage?: SendMessageOptions;
  /**
   * Enables `attachment_read`. Absent means no attachment index — a test harness, or a daemon
   * without attachment storage — and then the tool is not offered rather than offered and empty.
   */
  attachmentRead?: AttachmentReadOptions;
  /**
   * What is remembered about people and conversations: `memory_search`, `memory_analyze`, and the
   * conversation and person halves of `memory_read` / `memory_write`. Absent in a harness without
   * memory, and then those two reach the agent's own `MEMORY.md` only.
   */
  memory?: MemoryToolsDeps;
  /**
   * The turn log, so `memory_read` can read back what compaction archived. Absent means that half of the
   * tool is not offered.
   */
  earlierTurns?: EarlierTurns;
  /**
   * This install's own CLI: where to run it, and which binary. Absent means the tool is not offered
   * rather than offered and failing to find a daemon.
   */
  nourideCli?: { installDir: string; command: string; changesSharedTools?: (agentId: string) => boolean };
  /**
   * Checking for a newer release, and taking it. Absent means the tool is not offered.
   *
   * Absent in a test harness and in any build whose update provider did not resolve — and then the
   * tool is not offered rather than offered and failing, for the same reason `nourideCli` is not:
   * an agent told it can update the daemon, whose call comes back "not available in this build",
   * has spent an iteration learning the harness lied.
   */
  update?: UpdateToolOptions;
  /**
   * Where `person_record` and `person_notes` write. Absent means neither is offered.
   *
   * Only a test harness is without one in practice; the daemon always has a config path. Optional for
   * the same reason `sendFile` is — a tool that is present and cannot write is worse than one never
   * offered, because the model spends an iteration finding out.
   */
  people?: PeopleWriteDeps;
  audit?: AuditPort;
  /** Where `secret_save` keeps what it is handed. Absent, with no credentials held from chat either, it is not offered. */
  secretKeeping?: Pick<SecretKeeping, "has" | "keep" | "bind" | "changeFields">;
  /** Every credential the daemon holds itself: a printed credential file's value that is one keeps its mask (`exec`). */
  ownSecrets?: () => Record<string, string>;
  /** Where each conversation's work notes are kept (0.7.26): `notes`, and `plan` past the turn. Absent, neither keeps. */
  notes?: NotesPort;
}

export function createBuiltinTools(options: ToolRegistryOptions): Map<string, Tool> {
  const execTool = createExecTool({
    timeoutMs: options.security.toolTimeoutMs,
    maxOutputBytes: options.security.toolMaxOutputBytes,
    blocked: [],
    policy: options.security.exec,
    ...(options.liveGrants ? { liveGrants: options.liveGrants } : {}),
    ...(options.canAsk ? { canAsk: options.canAsk } : {}),
    ...(options.startJob ? { startJob: options.startJob } : {}),
    ...(options.childEnv ? { childEnv: options.childEnv } : {}),
    ...(options.heldSecrets ? { heldSecrets: options.heldSecrets } : {}),
    ...(options.ownSecrets ? { ownSecrets: options.ownSecrets } : {}),
  });

  const tools: Tool[] = [
    // Shows a picture under the same `[media]` answers `attachment_read` gives, when the daemon has them.
    createReadTool(options.attachmentRead ? readImagesFrom(options.attachmentRead) : undefined),
    writeTool,
    editTool,
    multiEditTool,
    globTool,
    grepTool,
    createPlanTool(options.notes),
    execTool,
    // The same sandbox as `exec`, by construction rather than by copy: one description of what may
    // run and where, so the two cannot drift into disagreeing.
    createSessionTool({
      normalizeCommand,
      resolveCwd,
      // A shell kept open is the widest command there is: only a secret bound to `*` reaches one.
      env: (ctx) => commandEnv(ctx, options.childEnv?.forCommand(ctx.agentId, null).env ?? {}),
      findBlocked: (argv) => findBlocked(argv, options.security.exec.blocked) ?? undefined,
      ...(options.heldSecrets ? { heldSecrets: options.heldSecrets } : {}),
      known: (ctx) => ({ ...options.ownSecrets?.(), ...options.childEnv?.(ctx.agentId) }),
    }),
    createMemoryReadTool(options.memory, options.earlierTurns),
    createMemoryWriteTool(options.memory, options.attachmentRead),
    createWebFetchTool({
      ...options.web,
      urlPolicy: { allowPrivate: options.security.web.allowPrivateUrls },
    }),
  ];

  const search = createWebSearchTool(options.web);
  if (search) tools.push(search);
  // Only when a backend was chosen *and* is unconfigured. Without a key at all, `resolveSearch` falls
  // back to the keyless one rather than withdrawing the tool — an agent with no way to search does not
  // stop searching, it writes a scraper and runs it through `exec`.
  else log.info("web_search not offered", { reason: "the configured backend is unusable" });

  if (options.memory) tools.push(createMemorySearchTool(options.memory), createMemoryAnalyzeTool(options.memory));
  if (options.notes) tools.push(createNotesTool(options.notes));
  if (options.sendFile) tools.push(createSendFileTool(options.sendFile));
  if (options.sendMessage) tools.push(createSendMessageTool(options.sendMessage));
  if (options.attachmentRead) tools.push(createAttachmentReadTool(options.attachmentRead));
  /**
   * Offered only when the binary is actually there.
   *
   * Same rule as `web_search` returning null with no backend: a tool in the schema is a promise the
   * model will try to keep, and one that ends in `Executable not found in $PATH` spends a tool
   * iteration to learn the daemon lied. A source checkout has no installed binary, so the tool is
   * simply absent there.
   */
  if (options.nourideCli) {
    tools.push(createNourideCliTool({ exec: execTool, ...options.nourideCli }));
  }
  if (options.update) tools.push(createUpdateTool(options.update));
  if (options.people) {
    tools.push(createPersonRecordTool({ deps: options.people, memory: Boolean(options.memory) }));
    tools.push(createPersonNotesTool({ deps: options.people, memory: Boolean(options.memory) }));
  }
  if (options.sessionStatus) tools.push(createSessionStatusTool(options.sessionStatus));
  if (options.heldSecrets && options.secretKeeping) tools.push(createSecretSaveTool({ held: options.heldSecrets, keeping: options.secretKeeping }));
  if (options.runSubagent) {
    tools.push(
      createDelegateTool({
        run: options.runSubagent,
        ...(options.startHelper ? { background: options.startHelper } : {}),
        ...options.waitedHelper,
        ...(options.isolateHelper ? { isolate: options.isolateHelper } : {}),
      }),
    );
  }
  // Built whenever the daemon can run one. Whether it is *offered* is decided per turn, in
  // `resolveToolset` — a single-agent install has nobody to ask, and that answer changes the moment
  // somebody runs `agent_create`, which the boot-time tool map would never notice.
  if (options.askAgent) tools.push(createAskAgentTool(options.askAgent));

  if (options.harness) {
    tools.push(
      createAgentCreateTool(options.harness),
      createAgentConfigureTool(options.harness),
      // Skill authoring shares the harness options: same registry, same agents directory.
      createSkillCreateTool(options.harness),
      createSkillToggleTool(options.harness),
    );
    // Only when the loop is wired: `skill_improve` raises a draft, and without somewhere for drafts
    // to go the tool would report success for a proposal nobody could ever see.
    if (options.reflection) tools.push(createSkillImproveTool({ reflection: options.reflection }));
    // Same condition and the same reason: an install only ever queues a draft.
    if (options.reflection && options.skillHub) tools.push(...createSkillHubTools(options.skillHub));
  }
  if (options.mcpCatalog) tools.push(createMcpSearchTool(options.mcpCatalog));

  const registry = new Map(tools.map((tool) => [tool.definition.name, tool]));

  // Auditing wraps every tool once, here, rather than being repeated in each implementation —
  // a tool added later cannot forget to record itself. Its waiting form too (`wrapBoth`), or a turn that may hold no work
  // in the background would be offered the form that moves it there.
  return options.audit ? new Map([...registry].map(([name, tool]) => [name, wrapBoth(tool, (form) => audited(name, form, options.audit!))])) : registry;
}

function createSessionStatusTool(
  provide: NonNullable<ToolRegistryOptions["sessionStatus"]>,
): Tool {
  return {
    requiresApproval: false,
    definition: {
      name: "session_status",
      description:
        "Report your current session: model, provider, chat, turn count and context size.",
      parameters: { type: "object", properties: {} },
    },
    async execute(_args, ctx) {
      const status = provide({
        agentId: ctx.agentId,
        chatId: ctx.chatId,
        gatewayId: ctx.gatewayId,
      });
      return {
        content: [
          `Agent: ${status.agent}`,
          `Model: ${status.model} (${status.provider})`,
          `Chat: ${status.gateway}:${status.chatId}`,
          `Turns in context: ${status.turns} (~${status.contextTokens} tokens)`,
          `Tools: ${status.toolNames.join(", ") || "none"}`,
        ].join("\n"),
        isError: false,
      };
    },
  };
}

export interface AgentToolset {
  definitions: ToolDefinition[];
  get(name: string): Tool | undefined;
  /**
   * Whether a call needs a human first.
   *
   * The agent's `approval_required` list is authoritative, not the tool's own flag. The
   * flag is only a default: `@nouride/persona` seeds the list with the mutating tools when
   * a pack does not mention it, so the safe posture holds by default while an operator who
   * writes the list explicitly gets what they asked for.
   */
  requiresApproval(name: string): boolean;
  /**
   * Whether this tool may run alongside other parallel-safe calls in the same batch.
   *
   * Answers `false` for a name it does not have, so a caller never has to check twice.
   */
  parallelSafe(name: string): boolean;
  /**
   * The per-call decision: run, ask, or refuse.
   *
   * Replaces the old boolean. A boolean could not express "refuse outright" — so a command over
   * the ceiling had to be reported as needing approval, and the operator was asked about something
   * that would have been refused whatever they answered.
   */
  gate(name: string, args: Record<string, unknown>, ctx: ToolContext): GateDecision;
  /** Per-agent blocked command patterns, applied by `exec`. */
  blockedPatterns: string[];
  /**
   * How many helpers `delegate` may have working in the background for this agent, as this toolset was resolved —
   * `[delegate] max_background`. 0, or absent: `delegate`'s schema has no `background`, and the harness says nothing of it.
   */
  backgroundHelpers?: number;
  /** The machine under this agent, as its prompt says it. Absent where the daemon was not given one. */
  machine?: MachineFacts;
}

/**
 * Live daemon state the toolset needs at decision time.
 *
 * Passed as functions, not values: whether a human can be reached changes while a turn runs, and a
 * captured boolean would answer for the moment the toolset was built.
 */
export interface ToolsetDeps {
  liveGrants?: (agentId: string) => Set<string>;
  /**
   * Extra environment for a command this agent runs — resolved credentials, and the path to the
   * credentials directory. See `buildEnv`: the value reaches the child process and never the model.
   */
  childEnv?: ChildEnv;
  /** Live durable grants for non-`exec` tools, keyed by `toolGrantKey`. */
  liveToolGrants?: (agentId: string) => Set<string>;
  /**
   * The credentials people sent in chat, held under handles (`tools/held-secrets.ts`): handed to a command that names
   * one, and masked out of every tool's result in their conversation.
   */
  heldSecrets?: TransientSecrets;
  /**
   * Every credential the daemon holds itself — the store's values, what the control token and the credentials directory's
   * files hold — masked out of every tool's result (`tools/secret-mask.ts`). Read per call: a rotation counts at once.
   */
  ownSecrets?: () => Record<string, string>;
  canAsk?: () => boolean;
  /** Starts a background job. Absent means `exec` does not offer `background: true`. */
  startJob?: ExecToolOptions["startJob"];
  /**
   * Tools from this agent's MCP servers, already named and gated.
   *
   * Merged in rather than looked up in `enabled`, because switching a server on **is** the
   * opt-in: the tool names come from the server and are not knowable when the pack is written, so
   * requiring them to be listed would mean connecting a server and discovering its tools by hand
   * before any of them could be used.
   *
   * They run without asking unless the agent's `approval_required` names them — the same rule as a
   * built-in, and deliberately so. See the header of `modules/tools/mcp.ts` for what that replaced.
   */
  mcpTools?: (agentId: string) => Map<string, Tool>;
  /**
   * Which other agents this one could ask right now. Absent, or empty, withdraws `ask_agent`.
   *
   * Live for the reason everything else in this interface is: a daemon with one agent has nobody to
   * ask, and `agent_create` changes that inside a running process. A tool in the schema is a promise
   * the model will try to keep, and the promise here would be "there are none" on every call.
   */
  peerAgents?: (agentId: string) => string[];
  /**
   * How many background helpers this agent may have at once, read per turn — `[delegate] max_background` is set live
   * from the dashboard. Absent, or 0: `background` is taken off `delegate`'s schema for this agent, so a tool the model
   * cannot use with it is not offered with it.
   */
  backgroundHelpers?: (agentId: string) => number;
  /** The machine and the missions it runs at once, for the prompt (`commons/machine.ts`). */
  machine?: (agentId: string) => MachineFacts;
  /**
   * `mission`, as this turn holds it (0.8.0): `start` in a chat's turn, the mission's own actions in a mission's — handed
   * per turn by what runs it. Absent: no `mission` — a helper's turn, a peer's, a scheduled one.
   */
  missionTool?: Tool;
  /** `work` (0.8.7): the agent's own missions, jobs and approvals, read and acted on through the daemon. */
  workTool?: Tool;
  /** `schedule`, in a chat's turn (0.8.0): work that runs later, proposed for a person to turn on. Absent elsewhere. */
  scheduleTool?: Tool;
  /** `persona` (0.8.8): follows the daemon, to every agent that holds a tool — it only proposes, and an admin decides. */
  personaTool?: Tool;
  /** `skill_root` (0.8.24): the same way — it only asks for a folder's skills, and an admin decides. */
  skillRootTool?: Tool;
  /** A mission's turn in a worktree of its own (0.8.1): `delegate` offers `isolated`. Absent: its schema has none. */
  helperWorktrees?: boolean;
}

/**
 * The directory a grant for this call would be confined to, or null when it cannot be confined.
 *
 * Only the agent's own workspace. A path that resolves under a configured `workspace_roots` entry — the
 * operator's actual source tree — returns null, so `always` is never offered for it: a standing
 * permission to write into a git repository is not something to hand out from a one-line prompt, and it
 * is exactly the case where the operator wants to see each change.
 *
 * A call with no `path` is also null. `write` without a path is a call the tool itself will refuse, and a
 * grant scoped to a directory nobody named would be a grant scoped to nothing.
 */
function grantScopeFor(args: Record<string, unknown>, ctx: ToolContext): string | null {
  if (typeof args.path !== "string" || args.path.trim() === "") return null;
  try {
    // Resolved against the workspace only. `resolveWithin` throws when the path escapes it, which is
    // precisely the signal that this call is out of scope for a workspace grant.
    resolveWithin(ctx.workspaceDir, args.path);
    return ctx.workspaceDir;
  } catch {
    return null;
  }
}

/**
 * Say so when a pack's `approval_required` is narrower than the default it replaced.
 *
 * The list **replaces** `DEFAULT_APPROVAL_REQUIRED`, it does not extend it, and the failure mode runs
 * backwards from how the line reads: writing `approval_required = ["write"]` looks like asking for a
 * gate and actually removes one from `edit`, `exec` and every harness tool. Found live — an agent
 * rewrote its own `config.toml` to widen its workspace roots with no prompt at all, on an install whose
 * operator believed the gate was on because he had named a tool in it.
 *
 * Only the tools this agent actually enables are named. Warning about a gated tool on a pack that
 * cannot call it is the kind of false positive that teaches operators to skim past warnings.
 */
export function droppedApprovalGates(tools: {
  enabled: string[];
  approvalRequired: string[];
  approvalRequiredExplicit?: boolean;
}): string[] {
  if (!tools.approvalRequiredExplicit) return [];
  return DEFAULT_APPROVAL_REQUIRED.filter(
    (name) => tools.enabled.includes(name) && !tools.approvalRequired.includes(name),
  );
}

function warnIfGateNarrowed(agent: LoadedAgent): void {
  const dropped = droppedApprovalGates(agent.config.tools);
  if (dropped.length === 0) return;

  log.warn("agent narrows the approval gate below the default", {
    agent_id: agent.config.id,
    dropped,
    hint: `[tools] approval_required replaces the default list rather than adding to it; ${dropped.join(", ")} now run without asking`,
  });
}

/**
 * Tools that come with another, for packs written before they existed: every agent on a box has an
 * explicit `[tools] enabled`, so a new tool reaches none of them until each file is edited. The hub
 * tools only search and queue a draft, so an agent trusted to write a skill may look for one.
 */
const IMPLIED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  skill_create: ["skill_search", "skill_install"],
  // An agent that may use a credential sent in chat may keep one: a new name asks at its level, a replaced one always.
  exec: ["secret_save"],
  // An agent that may put a file in its chat may put a message in another (0.7.23): asked at its approval level, every time.
  send_file: ["send_message"],
};

/** What `enabled` names, and what comes with it — where this daemon built it: a tool that comes along is never unknown. */
function withImplied(enabled: readonly string[], registry: ReadonlyMap<string, Tool>): string[] {
  return [...new Set(enabled.flatMap((name) => [name, ...(IMPLIED_TOOLS[name] ?? []).filter((implied) => registry.has(implied))]))];
}

export function resolveToolset(
  agent: LoadedAgent,
  registry: Map<string, Tool>,
  security: SecuritySection,
  deps?: ToolsetDeps,
): AgentToolset {
  const { enabled, approvalRequired, blocked } = agent.config.tools;

  const resolved = new Map<string, Tool>();
  const unknown: string[] = [];

  for (const name of withImplied(enabled, registry)) {
    const tool = registry.get(name);
    if (!tool) {
      // `"*"` names every built-in, and a build may lack one (`update`, where it cannot update itself):
      // nothing the operator wrote is wrong.
      if (!agent.config.tools.everyTool || !BUILTIN_TOOLS.includes(name)) unknown.push(name);
      continue;
    }
    // `exec` is rebuilt per agent so the pack's blocked patterns apply inside the tool
    // itself, rather than being checked somewhere the tool cannot see — and so a pack that
    // asked to be gated actually is.
    // A pack's own `blocked` patterns need an `exec` of their own; every other agent shares one.
    const ownExec = name === "exec" && blocked.length > 0;
    resolved.set(
      name,
      ownExec
        ? createExecTool({
            timeoutMs: security.toolTimeoutMs,
            maxOutputBytes: security.toolMaxOutputBytes,
            blocked,
            policy: security.exec,
            ...(deps?.liveGrants ? { liveGrants: deps.liveGrants } : {}),
            ...(deps?.canAsk ? { canAsk: deps.canAsk } : {}),
            ...(deps?.startJob ? { startJob: deps.startJob } : {}),
            // Rebuilt here too, not only in the registry. A pack with blocked patterns gets a fresh `exec`, and leaving
            // this off meant that agent's commands ran with no credentials at all — the same footgun `startJob` hit once.
            ...(deps?.childEnv ? { childEnv: deps.childEnv } : {}),
            ...(deps?.heldSecrets ? { heldSecrets: deps.heldSecrets } : {}),
            ...(deps?.ownSecrets ? { ownSecrets: deps.ownSecrets } : {}),
          })
        : tool,
    );
  }

  /**
   * `ask_agent` follows the daemon, not the pack — the same rule MCP tools follow below.
   *
   * Whether it is offered is `peerAgents`: another agent to reach, and `mentions_enabled` still on.
   * Both of those are the *operator's* switches, and this is the same capability an @mention already
   * is — in a room an agent hands work over with a tag, gated by nothing in `[tools] enabled`, and
   * refusing the DM half of it on a tool list would make the feature work in one chat shape and
   * silently not the other. It confers no new authority either: the peer runs under its own id, its
   * own grants and its own approval gate.
   *
   * Written this way round after a live deploy. It was in `DEFAULT_TOOLS` and nowhere else, which
   * reaches only a pack that says nothing about tools — and every real pack here enumerates. So the
   * prompt told Nouva to call a tool her schema did not carry, and the model spent its reasoning
   * looking for it before settling for `delegate`, which runs a helper as *herself*. The other agent
   * was never involved, and the answer came back as though it had been.
   */
  // Whether the pack gave this agent any tool at all — asked before the daemon adds its own below.
  const holdsTools = resolved.size > 0;
  const peers = deps?.peerAgents?.(agent.config.id) ?? [];
  const askAgent = registry.get("ask_agent");
  /**
   * How many turns this agent may have working in the background — helpers and asks together — as this toolset is
   * resolved: 0 for a helper's turn, a peer's, a scheduled one, and where `[delegate] max_background` is 0.
   */
  const backgroundHelpers = deps?.backgroundHelpers?.(agent.config.id) ?? 0;
  // An ask that runs long moves to the background (0.7.19) only where this turn may hold background work: elsewhere it
  // waits to the end, with no `background` in its schema (`waitingForm`).
  if (peers.length > 0 && askAgent) resolved.set("ask_agent", backgroundHelpers > 0 ? askAgent : waitingForm(askAgent));
  else resolved.delete("ask_agent");

  /**
   * `delegate`'s `background`, offered only where this agent may run helpers that way (0.7.15). Taken off the schema
   * rather than left to be refused: a parameter the model sees is one it will try, and a refusal costs a round trip. And
   * its helpers in the foreground move to the background after the wait only there: elsewhere they are waited for to the
   * end (`waitingForm`).
   */
  const delegate = resolved.get("delegate");
  if (delegate && backgroundHelpers === 0) resolved.set("delegate", waitingForm(delegate));
  // `isolated` the same way, offered only where it is not refused: a mission's turn in a worktree of its own (0.8.1).
  if (delegate && !deps?.helperWorktrees) resolved.set("delegate", withoutParameter(resolved.get("delegate")!, "isolated"));

  /**
   * `attachment_read` follows the daemon too, and for a reason of its own.
   *
   * It confers no authority the agent does not already have. A file that comes *with* a message is
   * fetched, stored and described to the agent unconditionally — no tool entry anywhere is consulted
   * for that, and an agent with an empty `[tools] enabled` still gets the description. This tool only
   * changes *when* a file is read: on request, for the files in the same conversation, instead of
   * automatically for the one that happened to arrive addressed.
   *
   * So gating it on the pack would withhold nothing while breaking the feature everywhere it is
   * needed. Every real pack here enumerates its tools, which is the exact trap `ask_agent` fell into:
   * the prompt tells the agent it can open the photo, and its schema does not carry the call.
   */
  const attachmentRead = registry.get("attachment_read");
  if (attachmentRead) resolved.set("attachment_read", attachmentRead);
  else resolved.delete("attachment_read");

  /**
   * `notes` follows the daemon too, to every agent that holds a tool at all (0.7.26). It writes only this agent's notes
   * for this conversation — no authority — and the work notes are only as good as their being there: a pack that lists
   * its tools, as every pack here does, would otherwise go without, and its long work would lose its place as before.
   */
  const notes = registry.get("notes");
  if (notes && holdsTools) resolved.set("notes", notes);
  else resolved.delete("notes");

  /**
   * `mission` follows the daemon too (0.8.0), to every agent that holds a tool at all: long work is something any agent
   * may be given, and a pack listing its tools would otherwise never learn it can hand work to a mission. It confers no
   * authority — a mission's turns run through the same gate, as the person who started it.
   */
  if (deps?.missionTool && holdsTools) resolved.set("mission", deps.missionTool);
  else resolved.delete("mission");

  // `work` the same way (0.8.7): it reaches only the agent's own items, through the daemon — no authority it lacked.
  if (deps?.workTool && holdsTools) resolved.set("work", deps.workTool);
  else resolved.delete("work");

  // `schedule` the same way (0.8.0): it only proposes — what it writes runs once a person has turned it on.
  if (deps?.scheduleTool && holdsTools) resolved.set("schedule", deps.scheduleTool);
  else resolved.delete("schedule");

  /**
   * `persona` the same way (0.8.8), in every turn — a mission's, an ask's, a job's: it confers nothing. It proposes a
   * change to the agent's own persona, which an admin answers at every approval level; and with the file tools refusing
   * those files, it is the agent's one way to say what should change in them.
   */
  if (deps?.personaTool && holdsTools) resolved.set("persona", deps.personaTool);
  else resolved.delete("persona");

  // `skill_root` the same way (0.8.24): a project's skills become instructions in the agent's prompt, so asking for them
  // is asking an admin, at every level, as a persona change is; it is the agent's one way to say which it should have.
  if (deps?.skillRootTool && holdsTools) resolved.set("skill_root", deps.skillRootTool);
  else resolved.delete("skill_root");

  if (unknown.length > 0) {
    // `ask_agent`, `attachment_read`, `notes`, `mission`, `work`, `schedule`, `persona` and `skill_root` are never in this list: all are daemon-resolved above, and
    // reporting a pack's own default as a mistake in its config would send the operator looking for a
    // typo that is not there.
    log.warn("agent enables tools that do not exist", { agent_id: agent.config.id, unknown });
  }

  // After the loop, so a pack cannot shadow an MCP tool by listing its name, and after `unknown` is
  // reported, so an MCP tool never appears in that warning. Never over a built-in: `read` from a server
  // would replace the one that keeps to the roots. Qualified names (`server__tool`) make it unlikely, not impossible.
  for (const [name, tool] of deps?.mcpTools?.(agent.config.id) ?? []) {
    if (resolved.has(name)) log.warn("an MCP tool has a built-in's name and is not offered", { agent_id: agent.config.id, tool: name });
    else resolved.set(name, tool);
  }

  /**
   * `exec nouride …` is sent back to the `nouride` tool — for an agent that holds both.
   *
   * Nothing stopped it before and nothing said not to, so it happened constantly: `exec` is the
   * familiar hammer, the command works, and the agent gets no signal that it took the wrong door.
   * The prompt already says the tool is the way, and this file's neighbours record what a preference
   * is worth against a habit — "a model told 'batch your calls' has a preference it can weigh against
   * its own habit, and it did."
   *
   * Three things are lost every time. The `stdin` field is the one that matters: `secret set`,
   * `provider add`, `gateway add` and `mcp add --stdin` read a credential from it and it is the
   * one argument this daemon never records, so the `exec` route puts that credential in the exec
   * grant, the audit log and the log table permanently. The second is the working directory — the
   * tool runs from the install, which is how the CLI finds *this* daemon on a box running two. The
   * third is the grant shape: an `exec` grant keyed on `nouride` argv is broader than the one verb
   * anybody approved.
   *
   * Scoped to an agent that actually has the tool, which is why it is here and not in `exec` itself:
   * a pack with `exec` and no `nouride` would otherwise be refused and pointed at a tool its schema
   * does not carry — the exact trap `ask_agent` fell into above.
   */
  const execTool = resolved.get("exec");
  if (execTool && resolved.has("nouride")) resolved.set("exec", viaNourideTool(execTool));

  // Every tool, not only `exec`: a secret printed into a session, a job log read back with `read`, or
  // an MCP server echoing its own token all reach the model the same way. See `tools/secret-mask.ts`.
  // And what was sent in this conversation as a secret, whichever tool hands it back (`tools/held-secrets.ts`), and
  // every credential the daemon holds itself.
  const childEnv = deps?.childEnv;
  const held = deps?.heldSecrets;
  if (childEnv || held || deps?.ownSecrets) {
    const known = (ctx: ToolContext) => ({ ...childEnv?.(ctx.agentId), ...heldValues(held, ctx) });
    for (const [name, tool] of resolved) resolved.set(name, withSecretMask(tool, known, deps?.ownSecrets));
  }

  warnIfGateNarrowed(agent);

  return {
    // Not a tool held back (`Tool.withheld`): an MCP tool the agent's `tools` list leaves out costs nothing to send.
    definitions: [...resolved.values()].filter((tool) => !tool.withheld).map((tool) => tool.definition).sort((a, b) => a.name.localeCompare(b.name)),
    get: (name) => resolved.get(name),
    requiresApproval: (name) => approvalRequired.includes(name),
    parallelSafe: (name) => resolved.get(name)?.parallelSafe === true,
    gate: (name, args, ctx) => {
      const tool = resolved.get(name);
      if (!tool) return { action: "refuse", reason: `unknown tool "${name}"` };

      // A tool with its own gate owns the whole decision, including whether the agent's
      // `approval_required` list applies — `exec`'s policy already expresses "never ask" as
      // `ask = "off"`, and honouring both would mean two knobs for one question.
      if (tool.gate) return tool.gate(args, ctx);

      // The fixed list, before anything this agent's own list says: asked every time, never granted.
      const listed = tool.fixedList?.(args, ctx);
      if (listed) return { action: "ask", grantable: false, hardline: true, hardlineClass: listed.class, reason: listed.reason };

      if (!approvalRequired.includes(name)) return heldAfterOutside(name, tool, args, ctx) ?? { action: "run", via: "ceiling" };

      // Everything else on the list can be granted, but only within the agent's own workspace.
      //
      // The previous rule was that `allow-always` is never offered here, because a durable grant is
      // bound to a command identity and `write` has none. True of an *unscoped* grant: "always allow
      // write" is a standing permission for content nobody has seen. Bound to the workspace it is no
      // broader than the sandbox the agent is already confined to, so the third answer is a real answer
      // rather than a policy change — and a write anywhere else still asks.
      const scope = grantScopeFor(args, ctx);
      if (scope === null) {
        // Not scopable: no path, or a path under a configured root rather than the workspace. Offering
        // `always` here would be offering a grant we would refuse to honour on the next call.
        return { action: "ask", grantable: false, reason: `${name} requires approval for this agent` };
      }

      const grantKey = toolGrantKey({ agentId: ctx.agentId, tool: name, scopeDir: scope });
      if (deps?.liveToolGrants?.(ctx.agentId).has(grantKey)) {
        return { action: "run", via: "grant", grantKey };
      }

      return {
        action: "ask",
        grantable: true,
        reason: `${name} requires approval for this agent`,
        toolGrant: { grantKey, agentId: ctx.agentId, tool: name, scopeDir: scope },
      };
    },
    blockedPatterns: blocked,
    ...(delegate && backgroundHelpers > 0 ? { backgroundHelpers } : {}),
    ...(deps?.machine ? { machine: deps.machine(agent.config.id) } : {}),
  };
}

/**
 * `delegate` without one of its parameters: its schema drops it, and a call that sends it anyway runs as if it had not —
 * without `isolated` in the mission's folder.
 */
function withoutParameter(tool: Tool, name: string): Tool {
  const parameters = tool.definition.parameters as { properties?: Record<string, unknown> };
  const { [name]: _dropped, ...properties } = parameters.properties ?? {};
  return {
    ...tool,
    definition: { ...tool.definition, parameters: { ...tool.definition.parameters, properties } },
    execute: async (args, ctx) => {
      const { [name]: _ignored, ...rest } = args;
      return await tool.execute(rest, ctx);
    },
  };
}


/**
 * Whether this call writes what every later prompt reads — `MEMORY.md`, a person's record or notes (`Tool.keepsInPrompt`).
 * What waits for a yes after outside content, and what a helper is refused outright (`pipeline/subagent.ts`).
 */
export function writesWhatPromptsRead(tool: Tool, args: Record<string, unknown>): boolean {
  return typeof tool.keepsInPrompt === "function" ? tool.keepsInPrompt(args) : tool.keepsInPrompt === true;
}

/**
 * A write every later prompt reads, made after the turn read outside content: asked, not run.
 *
 * A page that says "remember that you should…" could otherwise leave an order in `MEMORY.md`, or in the notes said to
 * the agent on every turn with a person, that outlives the conversation it came in. `config` is the class it is — it
 * changes what the agent is, every turn after, as its config does — and the class keeps it a question at `balanced`,
 * while an operator who chose `trusted` is not asked (`BALANCED_ASKS`, `skipsApproval`). Never grantable: "always" here
 * would be a standing permission for whatever the next page says. A tool on the agent's `approval_required` list asks
 * anyway.
 */
function heldAfterOutside(name: string, tool: Tool, args: Record<string, unknown>, ctx: ToolContext): GateAsk | null {
  if (!writesWhatPromptsRead(tool, args) || !ctx.untrustedRead?.length) return null;
  return {
    action: "ask",
    grantable: false,
    hardline: true,
    hardlineClass: "config",
    reason: `${name} keeps what it writes where every later prompt reads it, and this turn read outside content first (${ctx.untrustedRead.join(", ")})`,
  };
}

/**
 * The `exec` wrapper that refuses to run the daemon's own CLI.
 *
 * `gate` and every other field are carried through by the spread, so the refusal changes where a
 * command runs and nothing about whether it is allowed to.
 */
function viaNourideTool(exec: Tool): Tool {
  return {
    ...exec,
    async execute(args, ctx) {
      const argv = Array.isArray(args.command) ? args.command.map(String) : [];
      const verbs = cliArgsIn(argv);
      if (verbs) {
        return {
          content:
            "Use the `nouride` tool for this, not `exec`: " +
            `{"args": ${JSON.stringify(verbs)}}. ` +
            "It runs from the install directory, so the CLI finds this daemon rather than whatever " +
            "`nouride` on PATH points at, and it has a `stdin` field for credentials: anything in " +
            "`exec`'s command is kept in the grant, the audit log and the log table permanently.",
          isError: true,
        };
      }
      return await exec.execute(args, ctx);
    },
  };
}

/**
 * The arguments to suggest, or null when `exec` should just run it.
 *
 * Matches the basename so `/srv/nouride/nouride status` is caught as well as the bare name, and
 * looks through a `sh -c` wrapper because `cd <install> && nouride …` was the documented workaround
 * for the cwd problem the tool exists to solve — an agent that learned it from an old transcript
 * would otherwise sail straight past the refusal.
 *
 * **It gives up rather than guess.** The tool takes one argv array and nothing else, so a pipe, a
 * redirect, a second command or a substitution is something it cannot express; a quoted argument is
 * something this function cannot split without getting it wrong. The first version did guess, and
 * answered `sh -lc "nouride logs -n 500 | grep error"` with
 * `{"args": ["logs","-n","500","|","grep","error"]}` — argv the CLI would take literally, so the
 * refusal was handing back a command that runs something else. Those stay with `exec`, which is the
 * only tool that can actually run them.
 */
function cliArgsIn(argv: string[]): string[] | null {
  const [program, ...rest] = argv;
  const base = program?.split("/").pop();
  if (!base) return null;

  if (base === "nouride") return rest;
  if (!["sh", "bash", "zsh"].includes(base)) return null;

  const script = rest.find((arg) => !arg.startsWith("-"));
  if (!script) return null;

  const body = script.replace(/^\s*cd\s+\S+\s*&&\s*/, "").trim();
  if (/[|<>;&`'"]|\$\(/.test(body)) return null;

  const match = body.match(/^(?:\S*\/)?nouride\s+(.+)$/);
  return match?.[1] ? match[1].trim().split(/\s+/).filter(Boolean) : null;
}
