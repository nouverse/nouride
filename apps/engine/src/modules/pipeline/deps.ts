/**
 * What the pipeline is handed, and the handful of constants the stages agree on.
 *
 * Separated from the wiring so a collaborator can depend on the shape without importing the class
 * that owns it — every module in this directory takes `PipelineDeps`, and none of them should have
 * to reach through `Pipeline` to get at it.
 */

import type { ExternalBrains } from "./brain.ts";
import type { NotesPort } from "@/modules/notes/store.ts";
import type { CronPort } from "@/modules/cron/cron.store.ts";
import type { JobWakePort } from "@/modules/jobs/wakes.store.ts";
import type { AttachmentStore } from "@/modules/attachments/store.ts";
import type { AccessPort } from "@/modules/access/access.store.ts";
import type { AgentRegistry } from "@nouride/persona";
import type { ProjectSkills } from "@nouride/persona";
import type { ReflectionEngine } from "@/modules/reflection/index.ts";
import type { GrantsPort } from "@/modules/tools/grants.store.ts";
import type { ToolGrantsPort } from "@/modules/tools/tool-grants.store.ts";
import type { JobsPort } from "@/modules/jobs/jobs.store.ts";
import type { McpManager } from "@/modules/tools/mcp.ts";
import type { ApprovalGate } from "@/modules/tools/approval.ts";
import type { AutoApprovePort } from "@/modules/tools/auto-approve.store.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import type { SpendAlerts } from "@/modules/llm/spend-alerts.ts";
import type { ToolOutputSpill } from "@/modules/llm/spill.ts";
import type { SessionsPort } from "@/modules/sessions/sessions.store.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import type { TurnJournalPort } from "@/modules/turns/journal.store.ts";
import type { InboxPort } from "./inbox.store.ts";
import type { TurnShaper } from "./turn-shape.ts";
import type { MissionCommands } from "@/modules/hooks/builtins/mission.ts";
import type { ScheduleCommands } from "@/modules/hooks/builtins/schedule.ts";
import type { RoomMentionPort } from "./room-mention.store.ts";
import type { DeliveryPort } from "@/modules/turns/delivery.store.ts";
import type { ChatEventsPort } from "@/modules/chat-events/chat-events.store.ts";
import type { RoomsPort } from "@/modules/rooms/rooms.store.ts";
import type { RoomNamePort } from "@/modules/rooms/room-names.store.ts";
import type { RoomMessagesPort } from "@/modules/chat-events/room-messages.store.ts";
import type { ChatAttachmentsPort } from "@/modules/attachments/chat-attachments.store.ts";
import type { Memory } from "@/modules/memory/index.ts";
import type { Notifier } from "@/commons/notify.ts";
import type { BoxBusy } from "@/commons/box-load.ts";
import type { UsersPort } from "@/modules/users/users.store.ts";
import type { ChildEnv } from "@/modules/tools/exec-secrets.ts";
import type { TransientSecrets } from "@nouride/secrets";
import type { SecretKeeping } from "@/modules/tools/held-secrets.ts";
import type { Gateway, GlobalConfig, MessageEnvelope, Tool } from "@nouride/shared";


/** Debounce window for batching rapid incoming media events from the same sender into a single turn. */
export const BATCH_WINDOW_MS = 1500;

/**
 * How long a claim on a (message, agent) pair is remembered.
 *
 * Long enough to cover every connection's copy of the same message — they arrive within milliseconds
 * of each other — and short enough that the table stays small.
 */
export const CLAIM_TTL_MS = 60_000;
export const CLAIM_MAX_ENTRIES = 2_000;

/**
 * The sender id on a message this daemon synthesised rather than received.
 *
 * A real platform id cannot collide with it, so an audit reader can tell a job wake-up from a person —
 * and the turn it triggers is allowed to produce nothing, because nobody is waiting on a reply.
 */
export const SYSTEM_SENDER = "nouride:system";

export const isSystemEvent = (envelope: MessageEnvelope): boolean => envelope.senderId === SYSTEM_SENDER;

/**
 * One drop notice per chat per minute.
 *
 * A full queue drops many messages at once, and a per-message apology would itself be the flood. The
 * window is long enough to cover a burst and short enough that a chat which keeps overflowing keeps
 * hearing about it.
 */
export const DROP_NOTICE_THROTTLE_MS = 60_000;
/** Chats remembered for the throttle above. Cleared wholesale on overflow — see `noticeDropped`. */
export const DROP_NOTICE_CAP = 1000;

export interface PipelineDeps {
  config: GlobalConfig;
  registry: AgentRegistry;
  /**
   * Read-only, for one question: where does a reply in a cron session go? A follow-up there — a background
   * job a scheduled run started, waking its agent — answers into `cron:<jobId>`, which no platform
   * delivers; `Voice.reply` sends it where the job delivers instead.
   */
  cronJobs?: Pick<CronPort, "get">;
  /** Where a finished job's wake-up is recorded as taken, so a restart can find one that never was. */
  jobWakes?: Pick<JobWakePort, "markWoken">;
  providers: ProviderRegistry;
  sessions: SessionsPort;
  /**
   * What each turn did — the steps, the timings, the answer as it is written.
   *
   * Optional for the same reason `usage` is: a turn must never fail because the thing watching it did.
   * Absent in test benches and in any process that only needs to answer.
   */
  turns?: TurnsPort;
  /**
   * Every message of a running turn, committed as it happens — `modules/turns/journal.store.ts`.
   *
   * Optional like `turns`: without it a turn that dies keeps its question and a note, as before.
   */
  journal?: TurnJournalPort;
  /**
   * Messages written down before anything acts on them — `inbox.store.ts`. Optional: without it a message
   * waiting in the queue is lost to a restart, as it always was.
   */
  inbox?: InboxPort;
  /** Whether each reply reached its platform — `modules/turns/delivery.store.ts`. */
  delivery?: DeliveryPort;
  /**
   * Run writes as one transaction — the daemon's database's. A turn ends by writing its conversation,
   * clearing its journal and closing its record, and a crash between any two of those would leave them
   * disagreeing. Absent in test benches, where the writes simply run in order.
   */
  atomically?: <T>(work: () => T) => T;
  /**
   * Whether this daemon is a Box — paired, and writing to its card. Asked when a turn starts, since the plugin that
   * knows is loaded after the pipeline is built. A Box writes a partial answer less often (`APPLIANCE_REPLY_FLUSH`).
   */
  appliance?: () => boolean;
  /**
   * Things that happened *to* a conversation — see the header of `apps/engine/src/modules/chat-events/chat-events.store.ts`.
   *
   * Optional like `turns`, so a daemon assembled without it degrades to what existed before: the
   * events are not recorded and the prompt carries no block. Nothing branches on its absence beyond
   * the `?.` at each call site.
   */
  chatEvents?: ChatEventsPort;
  /**
   * Who is in a room, where the daemon owns that answer — see the header of `apps/engine/src/modules/rooms/rooms.store.ts`.
   *
   * Optional, and its *absence for a given chat* is meaningful rather than a degraded mode: every
   * platform chat has no membership list and must keep behaving as it does today.
   */
  rooms?: RoomsPort;
  /**
   * What people said in a room — see the header of `apps/engine/src/modules/chat-events/room-messages.store.ts`.
   *
   * Written before routing, because whether a message is part of the conversation does not depend on
   * whether anybody answers it.
   */
  roomMessages?: RoomMessagesPort;
  approvals: ApprovalGate;
  /** How long a turn its provider ended waits before it is tried again — `provider-resume.ts`. Tests shorten it. */
  providerResumeMs?: number;
  /** Dashboard accounts, read for a role: `/daemon-restart` is an admin's. Absent, nobody in a chat is one. */
  users?: Pick<UsersPort, "byId">;
  /** Durable exec grants. Absent in tests that do not exercise them. */
  grants?: GrantsPort;
  toolGrants?: ToolGrantsPort;
  /** The daemon's own voice — approval notices and alerts. Absent in tests. */
  notifier?: Notifier;
  /** Told each spend check, it says a day's step toward the cap once (`llm/spend-alerts.ts`). Absent in tests. */
  spendAlerts?: Pick<SpendAlerts, "check">;
  /** Inbound attachment storage. Absent means attachments are reported as unavailable, not ignored. */
  attachments?: AttachmentStore;
  /**
   * The conversation's list of files — see the header of `apps/engine/src/modules/attachments/chat-attachments.store.ts`.
   *
   * Written before routing, like the room's messages and for the same reason: a file in a message
   * that addressed nobody is still in the conversation, and it is the one nothing would otherwise
   * ever fetch.
   */
  attachmentIndex?: ChatAttachmentsPort;
  /**
   * Who may talk to the daemon. Required: an absent store fell back to the allowlist's meaning from before
   * `[security.access]` — "empty is everyone" — in a branch only tests ever reached.
   */
  access: AccessPort;
  /** Background jobs. Absent means `exec` does not offer `background: true`. */
  jobs?: JobsPort;
  /**
   * Where a tool result too big for the context is written, so the model gets a pointer instead.
   *
   * Absent means no capping, and then a 6MB `exec` enters the working set whole. Optional for tests
   * that never produce one; a daemon always has it.
   */
  spill?: ToolOutputSpill;
  /** Each conversation's work notes (`modules/notes/`). Absent in a test that needs none: nothing is kept, nothing sent. */
  notes?: NotesPort;
  /** The conversations whose turns are not a chat's — the missions (0.8.0, `turn-shape.ts`). Absent: every turn is a chat's. */
  shaper?: TurnShaper;
  /** What `/mission` reaches of the missions (`hooks/builtins/mission.ts`). */
  missionCommands?: MissionCommands;
  /** What `/schedule on|discard` reaches of the proposed jobs (`hooks/builtins/schedule.ts`). */
  scheduleCommands?: ScheduleCommands;
  /** `mission` as a chat turn holds it — `start` alone — and as a mission's own turn does (`tools/builtins/mission.ts`). */
  missionTools?: { chat: Tool; inside: Tool; work?: Tool };
  /** `schedule`, as a chat's turn holds it (0.8.0, `tools/builtins/schedule.ts`). Absent: no proposals. */
  scheduleTool?: Tool;
  /** `persona` (0.8.8): an agent's change to its own persona, proposed to an admin — in every turn (`tools/registry.ts`). */
  personaTool?: Tool;
  /** `skill_root` (0.8.24): an agent's request for a project's skills, put to an admin — in every turn, as `persona`. */
  skillRootTool?: Tool;
  /** The external agents' coding CLIs (0.8.1, `modules/external-agents`). Absent: every agent's turn is the executor's. */
  externalAgents?: ExternalBrains;
  /** An agent's own effort written to its pack, for `/effort … lock` (0.8.17): `setup/agent-effort.ts`, the Model tab's. */
  agentEffort?: (agentId: string, effort: string, actor: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** MCP connections, if any agent declared a server. Absent means no external tools. */
  mcp?: McpManager;
  /**
   * What the agents remember (`modules/memory`) — the recall block of the prompt, and the cut on
   * `/new` and `/reset`.
   *
   * Absent in tests that do not wire it, and then the prompt has no recall section and a reset cuts
   * nothing (the nightly pass still would).
   */
  memory?: Memory;
  /** Senders who said "stop asking". Absent means the feature is unwired and everything asks. */
  autoApprove?: AutoApprovePort;
  /** A group's own `groups_require_mention`, set with `/mention` (`room-mention.ts`). Absent, config alone decides. */
  roomMention?: RoomMentionPort;
  /** What each room is called — its platform's name and the operator's rename (`rooms/room-names.store.ts`, 0.7.24). */
  roomNames?: RoomNamePort;
  /** Minimum gap between progress-line edits. Lowered in tests; the default suits a chat platform. */
  progressIntervalMs?: number;
  /** How long the model works after its steps before the progress line says so (`chat-progress.ts`, ten seconds). Lowered in tests. */
  progressQuietMs?: number;
  /** Minimum gap between a turn's opening lines after the first (`preamble.ts`, two minutes). Lowered in tests. */
  preambleGapMs?: number;
  /**
   * Whether the machine is busy (`commons/box-load.ts`): a helper started in the background waits for room before it
   * starts (`background-helper.ts`). Nothing a person waits on asks it. Absent, nothing waits.
   */
  load?: BoxBusy;
  /** How often a helper waiting for room looks again (`room-wait.ts`, half a minute). Lowered in tests. */
  roomCheckMs?: number;
  /**
   * Token and cost recording.
   *
   * Absent in tests that do not care. A turn must never fail because accounting did, so this is
   * optional here rather than assumed present and guarded at every call site.
   */
  usage?: UsagePort;
  /**
   * Resolved credentials and the credentials directory, for a command this agent runs.
   *
   * Supplied by `index.ts`, where the secret store lives. The pipeline only passes it through — it
   * never reads a value, which is the point: nothing on the turn path holds a credential.
   */
  childEnv?: ChildEnv;
  /**
   * The credentials people sent in chat, held under handles for an hour (`chat-secrets.ts`). One for the daemon, shared
   * with the tools that use them. Absent, a message keeps what it says.
   */
  heldSecrets?: TransientSecrets;
  /**
   * Every credential the daemon holds itself — the store's values, the control token's, the credentials directory's —
   * which every tool's result is masked of before it is kept. Supplied by `index.ts`; passed through, never read here.
   */
  ownSecrets?: () => Record<string, string>;
  /**
   * What `/secret` keeps for good: a value under a name in the secret store, and the `exec_secrets` line that hands it
   * to the agent's commands. Supplied by `index.ts`, where the store and the packs are.
   */
  secretKeeping?: SecretKeeping;
  /** Named in the harness block so the agent knows credentials exist. A path, never a value. */
  credentialsDir?: string;
  /** Scans `<root>/.agents/skills` for the roots an agent named. Absent means the feature is off. */
  projectSkills?: ProjectSkills;
  /**
   * `skills/` beside the executable — the skills this build ships with.
   *
   * Here for one reason: `read` has to be able to open them. They are advertised to the agent *by
   * path* in the SKILLS block, and the read sandbox knew about the pooled directory and the project
   * ones but not this one, so every built-in skill was named in the prompt and refused by the tool
   * that was told to read it. Watched live, on the first document that needed one — the same bug the
   * pooled directory had, in a directory added after the fix.
   *
   * Absent in a source checkout, where the build stages nothing beside a binary that does not exist.
   */
  builtinSkillsDir?: string;
  /**
   * The supervised self-improvement loop, looked at once a turn has already replied.
   *
   * Optional, and optional in the way that matters: a turn must never fail, slow down or change its
   * answer because reflection was wired, misconfigured or unavailable. It is handed a finished turn
   * and everything it does afterwards is its own problem — see `ReflectionEngine.observe`.
   */
  reflection?: ReflectionEngine;
  /**
   * Typing keepalive interval, in ms.
   *
   * Exists so a test can prove the indicator survives a slow tool without waiting real seconds.
   * That regression — typing dying for the whole duration of every tool — is invisible at the
   * default 5s interval, and it is the one this knob is here to keep fixed.
   */
  typingRefreshMs?: number;
  /** Replaced via `setTools` once built — see the note there. */
  tools: Map<string, Tool>;
  gateways: Map<string, Gateway>;
  startedAt: number;
  version: string;
  /** Optional map tracking consecutive LLM failures per provider profile. */
  providerErrors?: Map<string, number>;
}
