/**
 * What a hook is, and what it is handed.
 *
 * Separate from the registry so a builtin can depend on the shape without importing the registry
 * that runs it — which would be a cycle, since the registry imports the builtins.
 *
 * Hooks are slash commands handled by the daemon rather than the model (§9 SPEC). A hook runs
 * *instead of* an agent turn: `/new` should not cost an LLM call, and `/stop` has to work when the
 * model is the thing that is broken.
 */

import type { MissionCommands } from "./builtins/mission.ts";
import type { ScheduleCommands } from "./builtins/schedule.ts";
import type { NotesPort } from "@/modules/notes/store.ts";
import type { AgentStatus } from "@/modules/pipeline/agent-status.ts";
import type { CliAnswering } from "@/modules/pipeline/brain.ts";
import type { ApprovalLevel } from "@nouride/shared";
import type {
  ApprovalDecision,
  ApprovalRequest,
  Gateway,
  LoadedAgent,
  MessageEnvelope,
  SessionKey,
} from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import type { SessionsPort } from "@/modules/sessions/sessions.store.ts";
import type { Answerer, ApprovalGate } from "@/modules/tools/approval.ts";
import type { GrantsPort } from "@/modules/tools/grants.store.ts";
import type { SkillDraft } from "@/modules/reflection/types.ts";
import type { ModelOverrides } from "./model-overrides.ts";
import type { RestartOutcome, RestartRequest } from "@/modules/update/restart.ts";

export interface HookContext {
  agent: LoadedAgent;
  envelope: MessageEnvelope;
  gatewayId: string;
  chatId: string;
  senderId: string;
  args: string[];
  deps: HookDeps;
}

export interface HookResult {
  reply?: string;
  /** False lets the message fall through to the agent — used by `/help` on no match. */
  handled: boolean;
}

/**
 * The credentials people send in chat, for `/secret` (`builtins/secrets.ts`): what a conversation holds, keeping one
 * under a name, and a message put back as written. Built by the pipeline over
 * `pipeline/chat-secrets.ts`, which holds them.
 */
export interface SecretsHookPort {
  /** What this conversation holds — never a value. */
  held(where: { gatewayId: string; chatId: string; gateway?: string; chatType?: string }): { handle: string; label: string; minutesLeft: number }[];
  /** An admin by name, as for `/daemon-restart`: paired or on an allowlist, and an admin's person under People. */
  mayManage(envelope: MessageEnvelope): boolean;
  /**
   * Keep what a handle holds under a name in the secret store, and hand it to every command of the chat's agent unless
   * its pack already names it (`already`): `handed` is the variable they get it as, or why it was not handed.
   */
  keep(input: { name: string; handle: string; where: { gatewayId: string; chatId: string; gateway?: string; chatType?: string }; replace: boolean; actor: string; agentId: string }): Promise<
    | { status: "kept" | "replaced"; handed: { variable: string; already: boolean } | { error: string } }
    | { status: "exists" | "gone" }
    | { status: "invalid"; error: string }
  >;
  /** The sender's message back as they wrote it, delivered as an edit of itself. False when there is none to put back. */
  putBack(envelope: MessageEnvelope, handle?: string): boolean;
}

/**
 * Where a group's `groups_require_mention` comes from: its own `/mention`, the connection, the daemon — or, for a room
 * made in the dashboard, that room's own rule, which the daemon's setting for chat-app groups does not reach.
 */
export type MentionSource = "group" | "gateway" | "daemon" | "room";

/** A group's own mention setting, for `/mention` (`builtins/mention.ts`) — built by `pipeline/room-mention.ts`. */
export interface GroupMentionHookPort {
  /** What this chat's unaddressed messages need, and which place said so. */
  here(envelope: MessageEnvelope): { requireMention: boolean; source: MentionSource };
  /** Set this group's own value, or `null` to remove it. False when `null` found nothing to remove. */
  set(envelope: MessageEnvelope, requireMention: boolean | null, actor: string): boolean;
  /** An admin by name, as for `/daemon-restart`: paired or on an allowlist, and an admin's person under People. */
  mayChange(envelope: MessageEnvelope): boolean;
  /** True for the first copy of this command in this group — every bot in it is handed one — and false for the rest. */
  firstCopy(envelope: MessageEnvelope, command: string): boolean;
}

/** What `/stop` stopped in the background: how many helpers, and which agents' work on what it had asked. */
export interface StoppedInBackground {
  helpers: number;
  asked: string[];
}

export interface HookDeps {
  registry: AgentRegistry;
  /** A group's own `groups_require_mention`, for `/mention`. Absent where nothing stores it. */
  groupMention?: GroupMentionHookPort;
  /**
   * The daemon's restart, for `/daemon-restart` — `modules/update/restart.ts`. `request` answers null where this
   * process cannot restart itself; `mayRestart` is asked first, see `builtins/daemon.ts`.
   */
  restart?: {
    request(request: RestartRequest): RestartOutcome | null;
    /** Paired or on an allowlist, and an admin by `[[people]]` — `senderIsAdmin` in `modules/people/match.ts`. */
    mayRestart(envelope: MessageEnvelope): boolean;
  };
  sessions: SessionsPort;
  /** `resolve` is present on gates that can actually be answered — see approvals.store.ts. */
  approvals: ApprovalGate & {
    resolve?: (id: string, decision: ApprovalDecision, by: string | Answerer, reason?: string) => boolean;
    /** Conversation-scoped pending list — present on the SQLite gate. */
    pendingForChat?: (agentId: string, gatewayId: string, chatId: string) => ApprovalRequest[];
    /**
     * Requests in this conversation that have already been answered or have expired.
     *
     * Read only to explain an answer that arrived too late — see `noPendingReply`. Present on the
     * SQLite gate; a gate without history simply gives the shorter reply.
     */
    recentlySettledForChat?: (
      gatewayId: string,
      chatId: string,
      sinceMs: number,
    ) => ApprovalRequest[];
    /**
     * The request this conversation is currently showing, when several are pending.
     *
     * A prompt is posted one at a time — see `tools/approval-floor.ts` — so a bare `/approve` means
     * the one on screen, not "whichever of these two". Present on the SQLite gate; a gate without
     * one falls back to asking for an id.
     */
    displayedForChat?: (gatewayId: string, chatId: string) => string | null;
    /**
     * Keep these out of the queue — they are about to be answered in bulk.
     *
     * Without it, `/approve all` posts a prompt for the second request at the instant it approves it.
     * See `tools/approval-floor.ts`.
     */
    stopShowing?: (ids: readonly string[]) => void;
  };
  /** The credentials people send in chat, for `/secret`. Absent where the daemon takes none out of messages. */
  secrets?: SecretsHookPort;
  /** Standing command permissions, for `/grants`. Absent where durable grants are not wired. */
  grants?: GrantsPort;
  /** The missions, for `/mission` (0.8.0). Absent where none are run. */
  missions?: MissionCommands;
  /** Proposed jobs, for `/schedule on|discard` (0.8.0). Absent where none are run. */
  proposals?: ScheduleCommands;
  /**
   * Whether this sender is an admin by `[[people]]` — `senderIsAdmin` in `modules/people/match.ts`. In a room, the one
   * besides the person who asked who may answer an approval. Absent, nobody in a chat is one.
   */
  isAdmin?: (envelope: MessageEnvelope) => boolean;
  /**
   * End this conversation, for `/new` and `/reset` — the one way any conversation ends, which decides what that clears
   * (`pipeline/conversation-end.ts`). Says what it filed into memory, and how many approvals it expired.
   */
  endConversation(key: SessionKey, mode: "new" | "reset"): Promise<{ cut?: { episodes: number }; expired: number; tasks: number }>;
  /** This chat's work notes, for `/notes` and for what `/new` keeps (`modules/notes/`). Absent where none are kept. */
  notes?: Pick<NotesPort, "tasks" | "plan" | "clear">;
  /**
   * Renders the system prompt this agent would receive right now, for `/prompt`.
   *
   * Supplied by the pipeline because assembling it needs the tool registry and provider
   * config, which hooks have no business reaching into.
   */
  renderPrompt?: (agentId: string, ctx: HookContext) => Promise<string>;
  /**
   * Compacts this conversation on demand, for `/compact`.
   *
   * Supplied by the pipeline for the same reason as `renderPrompt`: summarising needs a provider
   * client, and a hook has no business resolving one. Absent where no provider is wired.
   */
  compactSession?: (
    agentId: string,
    ctx: HookContext,
  ) => Promise<{ status: "compacted" | "empty" | "nothing_to_do" | "failed" | "over_budget"; before: number; after: number; turns: number; refusal?: string }>;
  /** Each sender's own approval level, for `/approvals`. Absent means the feature is unwired. */
  autoApprove?: {
    enable(gatewayId: string, senderId: string, by: string): boolean;
    disable(gatewayId: string, senderId: string, by: string): boolean;
    enabled(gatewayId: string, senderId: string): boolean;
    /** This person's own level, or nothing if they have not set one. */
    levelFor(gatewayId: string, senderId: string): ApprovalLevel | undefined;
  };
  /**
   * `[security] approvals` — the daemon-wide fallback, for `/approvals` to report.
   *
   * Passed rather than read from a config object, because a hook is handed the narrowest thing it
   * needs: this one has to *say* what the default is, not reach the config that holds it.
   */
  daemonApprovals?: ApprovalLevel;
  /**
   * A side question, for `/btw` (0.8.17): answered read-only beside the work and kept out of the conversation
   * (`pipeline/side-question.ts`). The reply: the marked answer, or why there is none. Absent where it is not wired.
   */
  sideQuestion?: (agent: LoadedAgent, envelope: MessageEnvelope, question: string) => Promise<string>;
  /** Per-conversation model overrides from `/model`, and efforts from `/effort`, kept on the conversation's row (076). */
  modelOverrides: ModelOverrides;
  /** The efforts an agent's coding CLI offered for its model, for `/effort` (0.8.16); empty before its first session. */
  cliEfforts?: (agentId: string) => string[];
  /**
   * An agent's own effort, `[llm] effort` in its pack, for `/effort … lock` (0.8.17): the write the Model tab and the CLI
   * tab make (`setup/agent-effort.ts`). Absent where a chat writes no pack.
   */
  agentEffort?: {
    /** Paired or on an allowlist, and an admin by `[[people]]`: the pack is every chat's, not this one's. */
    mayChange(envelope: MessageEnvelope): boolean;
    /** A level, or "default" to take the agent's own away. */
    set(agentId: string, effort: string, actor: string): Promise<{ ok: true } | { ok: false; error: string }>;
  };
  /**
   * Stop what this agent is doing in this conversation — a turn in flight, so `/stop` can interrupt
   * rather than only refuse new work.
   *
   * No gateway id. A turn is keyed by the connection that delivered its trigger and a command by the
   * one that delivered the command, and in a channel holding several bots those are routinely
   * different — so naming it made `/stop` miss the turn it was aimed at.
   */
  cancelTurn?: (agentId: string, chatId: string) => boolean;
  /**
   * Stop what this agent has working in the background for this conversation — its helpers (0.7.15) and the agents it
   * asked whose answers are still to come (0.7.19) — whichever connection started them: the same reason `cancelTurn`
   * takes no connection. What was stopped, to say so.
   */
  stopBackground?: (agentId: string, chatId: string) => StoppedInBackground;
  /** What an agent is doing now, for `/status` — `pipeline/agent-status.ts`. */
  agentStatus?: (agentId: string) => AgentStatus;
  /** What answers an agent its coding CLI answers, in this conversation, for `/status` (0.8.8); null for any other. */
  answering?: (agent: LoadedAgent, gatewayId: string, chatId: string) => CliAnswering | null;
  daemon: { startedAt: number; version: string };
  /** Resolves a gateway instance by id, for `/commands`. */
  resolveGateway?: (gatewayId: string) => Gateway | undefined;
  /** Returns all registered hooks, for `/commands`. */
  listHooks?: () => Hook[];
  /** Token usage for a session since a given timestamp, for `/status`. */
  sessionUsage?: (
    sessionId: string,
    since: number,
    /** A coding CLI's prompts alone (`UsageStore.forSession`). */
    onlyCli?: boolean,
  ) => {
    inputTokens: number;
    outputTokens: number;
    lastInputTokens: number;
    cachedInputTokens: number | null;
  };
  /**
   * Skill drafts waiting for a human, for `/drafts`.
   *
   * The four methods `ReflectionEngine` exposes to a person, and not the engine itself: a hook has no
   * business being able to *raise* a draft, and typing the dependency by what it may do is what keeps
   * that true. Absent means the loop is not wired, and the command says so instead of pretending.
   */
  drafts?: {
    pending(): SkillDraft[];
    resolve(reference: string): SkillDraft | null;
    /**
     * Every pending draft under one name.
     *
     * Names collide on purpose: two sessions can each propose an improvement to the same skill and
     * both wait for a person. `resolve` refuses an ambiguous name rather than guessing, so the
     * command needs this to say *why* a name did not resolve instead of claiming nothing is there.
     */
    pendingAllByName(name: string): SkillDraft[];
    approve(id: string, by: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
    deny(id: string, by: string): boolean;
  };
}

export interface Hook {
  command: string;
  description: string;
  /** Whether a paused agent still handles it — `/start` must, `/new` must not. */
  worksWhilePaused?: boolean;
  /**
   * Keep it working, keep it out of the menus.
   *
   * For a renamed command: the old name has to keep answering, or a habit becomes a dead end — but
   * advertising it in `/help` and in the platform's own command list teaches the new name to nobody
   * and leaves two entries doing one job.
   */
  hidden?: boolean;
  /**
   * About the group, not an agent — `/mention`. Answered before routing, addressed or not, by the bot it arrived on
   * (`pipeline/room-mention.ts`): in a room several of our bots share, an untagged command reaches nobody otherwise.
   */
  aboutTheGroup?: boolean;
  handler: (ctx: HookContext) => Promise<HookResult>;
}
