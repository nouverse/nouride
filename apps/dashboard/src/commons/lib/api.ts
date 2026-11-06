/**
 * API client.
 *
 * Same-origin in production (the engine serves this SPA), proxied by Vite in dev —
 * so paths are always root-relative and there is no base URL to configure.
 *
 * Authentication is a cookie the browser holds and never reads: the session token is `httpOnly`, so
 * there is no token in `localStorage` for a script on this page to find. `credentials: "same-origin"`
 * is what carries it, and it is on every request rather than on the ones that seemed to need it.
 *
 * A field is optional, and its absence read as what a daemon older than the field meant, though this SPA ships in
 * the same tarball as the daemon: an update swaps `dashboard/` at once and restarts the daemon only once it is idle
 * (`apps/engine/src/modules/update/self-update.ts`) — minutes behind a turn, hours behind a background job — and the
 * engine serves these files from disk on every request, so a reload in between runs this code against the old
 * daemon. Those fallbacks are not dead; a new field gets one too.
 */

export interface HealthPayload {
  /** `starting` from the moment the daemon binds its port until its boot is done (D1). */
  status: "starting" | "ok" | "degraded" | "shutting_down";
  /** While starting: what boot is doing — "connecting MCP servers". */
  phase?: string;
  uptime: number;
  version: string;
  /** The event stream's contract version, from 0.7.8 — absent on an older daemon. */
  eventProtocol?: string;
  /**
   * Which build this is — `basic`, `router`, `pro`, or `unknown` for one built from source.
   *
   * Optional because a dashboard can be newer than the daemon it is talking to: an operator
   * who updated the browser tab but not the binary would otherwise see `undefined` rendered.
   */
  edition?: string;
  /** A paired Nouride Box. Absent from a daemon older than the Pro editions, which no Box runs. */
  appliance?: boolean;
  agents: number;
  gateways: Record<string, string>;
  issues?: string[];
  /** The packs that did not load, by id — absent when none failed, and from a daemon older than 0.7.11. */
  failedAgents?: string[];
}

export interface SetupState {
  hasUser: boolean;
  hasProvider: boolean;
  hasAgent: boolean;
  complete: boolean;
  /**
   * Whether this install has an external identity provider, and what to call it on the button.
   *
   * Optional because a daemon older than the field answers without it, and the login page has to
   * treat that as "no button" rather than as a crash.
   */
  oauth?: { available: boolean; label: string };
  /**
   * The bundled LLM gateway, when switched on. Loopback — see `bundled-gateway.ts`. `sharedCredential`: how
   * the gateway came to hold this daemon's admin credential, if it did.
   */
  bundledGateway?: { available: boolean; baseUrl?: string; sharedCredential?: "environment" | "generated"; mount?: string; dashboard?: boolean };
  /**
   * Whether to draw the password form.
   *
   * Optional, and **absent must read as true**: a daemon older than the setting
   * says nothing, and a login page with neither a form nor a button is
   * unanswerable.
   */
  passwordLogin?: boolean;
}

export interface User {
  id: string;
  username: string;
  /** What to call them. Empty means nobody has said — the agent then uses no name at all. */
  displayName: string;
  role: "admin" | "operator" | "viewer";
  createdAt: number;
  updatedAt: number;
  mustChangePassword: boolean;
  lastLoginAt: number | null;
  /** False for an account added by email alone: it signs in through the provider only. */
  hasPassword?: boolean;
}

export interface Principal {
  kind: "token" | "user";
  role: User["role"];
  actor: string;
  user: User | null;
}

/** A provider profile and a model on it: one of an agent's fallbacks. */
export interface FallbackPair {
  provider: string;
  model: string;
}

export interface AgentSummary {
  id: string;
  /** When the daemon first saw it, ms (0.8.1): the order agents were made in. Null or absent from older daemons. */
  since?: number | null;
  displayName: string;
  /** What it is for, as its peers read it — the `Headline:` line of its IDENTITY.md. Absent from a daemon before 0.7.18. */
  headline?: string | null;
  enabled: boolean;
  state: string;
  /** What it is doing now, and why it could not work if asked. Absent from a daemon before 0.7.18. */
  activity?: {
    activity: "waiting" | "working" | "asleep" | "idle";
    working: { gatewayId: string; chatId: string }[];
    jobs: number;
    /** Missions at work, and missions waiting for a person (0.8.15); absent from an older daemon. */
    missions?: number;
    missionsWaiting?: number;
    waiting: number;
    unavailable: string | null;
  };
  provider: string;
  model: string;
  /** Who answers when the model cannot, in order; empty for none. Absent from a daemon before 0.8.0. */
  fallbacks?: FallbackPair[];
  /**
   * How long its model thinks: `[llm] effort`, else `[llm.defaults] effort`, null for neither; and the install's
   * `[llm.defaults] effort`, which "default" follows. Absent from a daemon before 0.8.17.
   */
  effort?: string | null;
  effortDefault?: string | null;
  /**
   * Its small and high tiers: the pack's own (`own`, null when it inherits) and what it inherits — the install's on
   * the install's provider, else its own model. Absent from a daemon before 0.8.0.
   */
  tiers?: Record<"small" | "high", { own: string | null; inherits: string }>;
  /** What its turns are budgeted at, and where that number comes from. Absent from a daemon before 0.7.13. */
  contextWindow?: { tokens: number; source: "pack" | "gateway" | "table" | "default" };
  tools: string[];
  /** What the pack says. `per-person` means each person's own setting decides. */
  approvals: "per-person" | "careful" | "balanced" | "trusted";
  /** Whether its connections take new senders; `follow` defers to the daemon. Absent from an older daemon. */
  access?: "follow" | "pair" | "allowlist";
  /** Whether, as the orchestrator, it installs the programs every agent runs (0.8.0). Absent before. */
  sharedTools?: boolean;
  /** Its second look (0.8.0): the pack's own `model_guard` or null, and the daemon's. Absent before. */
  secondLook?: { own: string | null; install: string };
  /** This agent's own tool budget, or null when it follows the daemon's. */
  maxToolIterations?: number | null;
  /** Seconds this pack pins, or null when it follows the daemon's clock. */
  maxTurnSeconds?: number | null;
  jobQuietAfterMinutes?: number | null;
  /** Helpers it may have working in the background at once, or null when it follows the daemon's. Absent before 0.7.15. */
  maxBackgroundHelpers?: number | null;
  /** Missions it may have working at once, or null when it follows the daemon's. Absent before 0.8.11. */
  missionsPerAgent?: number | null;
  /** An external agent's coding CLI and the profile it is signed in on (0.8.1). Absent for any other agent. */
  external?: AgentExternal;
  /** The parts of its cat in the Office its pack picks (0.8.1); the rest come from its id. */
  look?: AgentLook;
}

export interface StatusPayload {
  status: string;
  uptime: number;
  configSource: string | null;
  dataDir: string;
  /** Who answers a message that names no agent, and is the front desk of rooms (`[daemon] orchestrator`). */
  orchestrator: string | null;
  agents: AgentSummary[];
  gateways: { id: string; platform: string; status: string }[];
  /** What the helper model's work ran into in the last 24 h — none is none. Absent from a daemon before 0.7.25. */
  helpers?: HelperTrouble[];
}

export interface FileSummary {
  name: string;
  label: string;
  description: string;
  exists: boolean;
  bytes: number;
  modifiedAt: number | null;
}

export interface ChatMessageStep {
  name: string;
  text: string;
  at?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
  steps?: ChatMessageStep[];
}

export interface SessionSummary {
  id: string;
  agentId: string;
  chatId: string;
  gatewayId: string;
  updatedAt: number;
  /** A turn is running in it right now — what draws the spinner in the list. */
  running?: boolean;
  /** The first thing asked in it. `web-1757003921` names nothing; the question does. */
  title?: string;
}

/**
 * One thing the agent did, with how long it took.
 *
 * `kind` separates what it *said to itself* from what it *did*: `reasoning` is the model's own account
 * of what it is working out, `tool`/`tool_done` bracket a call, `waiting` is parked on a human, and
 * `note` is the daemon remarking on a call without being its result — a spilled output, which arrives
 * before the result and was read as one until it had a kind of its own.
 *
 * `steer` and `steer_reply` are said rather than done: a message sent while the turn worked, and what its
 * sender was told back at once. Drawn as the conversation inside the turn, never as steps of it.
 */
export interface TurnStep {
  seq: number;
  at: number;
  kind: "reasoning" | "tool" | "tool_done" | "note" | "waiting" | "steer" | "steer_reply" | "retry" | "compact";
  text: string;
  /** Since the previous step, or since the turn began. Computed by the daemon from its own clock. */
  ms: number;
  /** The call a step pairs by, and the tool — absent on a turn recorded before 0.7.6. */
  callId?: string;
  name?: string;
  /** A result's failure, and how — `exit` is a command answering no, the rest the call not doing its job. */
  error?: boolean;
  outcome?: "ok" | "exit" | "failed" | "timed_out" | "killed";
  /** A `steer` that is a person's edit: the message it changes (stream 1.3). Absent from a daemon before it. */
  editOf?: string;
}

export type TurnStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

/** Why the daemon started a turn nobody typed: what pushed it, the job, and how the job ended (`turns.store.ts`). */
export interface TurnCause {
  via: string;
  job?: string;
  outcome?: "finished" | "failed" | "stopped" | "interrupted";
  /** The job was a helper working in the background (0.7.15). Absent from a daemon before it. */
  helper?: true;
  /** The job was an ask that moved to the background (0.7.19): the agent asked. Absent from a daemon before it. */
  asked?: string;
  /** For an edit (`via: "edit"`): the platform id of the message edited. */
  of?: string;
}

/**
 * One exchange, as the daemon recorded it.
 *
 * The transcript is made of these rather than of chat messages, which is what makes a reload show the
 * same thing the live view showed: the steps, the clock and the reply all come from the daemon, and
 * none of them are reconstructed here.
 */
export interface ChatTurn {
  id: string;
  agentId: string;
  /** The chat inside the conversation — what a stop is addressed by. */
  chatId: string;
  /**
   * The session that owns this turn.
   *
   * A file URL has to name it: the route treats the session in the path as a permission and refuses
   * a turn belonging to another. Building those URLs from the conversation the page had open was
   * right in a one-to-one chat and wrong in a room, where it is one member's session — so every
   * attachment from any other member came back 404 and drew a broken image.
   */
  sessionId?: string;
  /** Nobody typed this: a background job finishing woke the agent. Not drawn as the operator's words. */
  system?: boolean;
  /** Why the daemon started it, as data — absent on a turn from before 0.7.8. */
  cause?: TurnCause;
  /** Files sent with the question. Metadata only — the bytes live in the agent's attachment store. */
  attachments?: TurnAttachment[];
  status: TurnStatus;
  prompt: string;
  reply: string;
  error?: string;
  model?: string;
  toolCalls: number;
  /**
   * Model round trips.
   *
   * The number that decides what a turn cost: every round trip re-sends the whole conversation, so
   * five tool calls in one and five in five are the same work at very different prices.
   */
  iterations?: number;
  inputTokens?: number;
  outputTokens?: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  steps: TurnStep[];
}

/** The running (or most recent) turn, plus the cursor to ask from next time. */
export interface LiveTurn extends ChatTurn {
  cursor: number;
}

/**
 * A slash command the daemon handles itself, instead of an agent turn.
 *
 * `command` carries its leading slash, exactly as it is typed.
 */
export interface SlashCommand {
  command: string;
  description: string;
}

/** A file the daemon has taken and can attach to a turn. */
export interface UploadedFile {
  /** Where it landed. Only `/chat/send` accepts this, and only from the uploads directory. */
  path: string;
  name: string;
  mimeType: string;
  bytes: number;
}

/**
 * A file on a turn — sent by the person, or back by the agent.
 *
 * `url` is relative to the control API and addresses the file by its position on the turn; the daemon
 * is the only thing that knows where it lives on disk. Absent when the bytes were never saved (a
 * download that failed, or a file older than the retention sweep).
 */
export interface TurnAttachment {
  name: string;
  mimeType: string;
  kind: string;
  bytes?: number;
  direction: "in" | "out";
  url?: string;
}

/** Work still running in the background of this conversation. */
export interface RunningJob {
  id: string;
  /** `helper: <goal>` for a helper `delegate` started (0.7.15); `ask <agent>: <task>` for an ask that moved there (0.7.19). */
  command: string;
  startedAt: number;
  /** Absent from a daemon before 0.7.15; `ask` from 0.7.19. */
  kind?: "command" | "helper" | "ask";
}

export interface ChatSession {
  id: string;
  agentId: string;
  chatId: string;
  gatewayId: string;
  updatedAt: number;
  /** False for a conversation that happened on Telegram or Discord: readable here, answered there. */
  writable: boolean;
}

/**
 * Something that happened *to* a conversation, rather than something said in it.
 *
 * `audience` is what the daemon decides and this client only displays: `"agents"` means the sentence
 * was also composed into each agent's next prompt, `"ui"` means it never reaches a model. Shown
 * either way — the distinction is about the model's context, not about who may read it.
 */
export interface ChatEvent {
  id: string;
  gatewayId: string;
  chatId: string;
  audience: "agents" | "ui";
  kind:
    | "joined"
    | "left"
    | "topic"
    | "moved"
    | "dropped"
    | "ambiguous"
    | "hop_budget"
    /** One agent in this room asked another to take something on. */
    | "delegated"
    | "restart"
    /** A credential a person sent was taken out of their message before anything kept it. */
    | "secret"
    | "note";
  text: string;
  agentId?: string;
  actor?: string;
  details?: Record<string, unknown>;
  at: number;
}

/**
 * A conversation with one person and several agents in it.
 *
 * `title` absent means nobody named it and the client shows the member list — derived here rather
 * than stored, because a name built at creation stops being right the moment a member is added.
 */
export interface Room {
  gatewayId: string;
  chatId: string;
  title?: string;
  createdBy?: string;
  createdAt: number;
  /**
   * When it was last used — the newest of its creation, its messages and its turns.
   *
   * Derived by the daemon rather than stored, and it is what the sidebar sorts on: a room ordered by
   * its creation date sinks down the list while it is the one being used.
   */
  updatedAt?: number;
  /**
   * True while an agent is mid-turn in it.
   *
   * From the daemon, not from this tab's own state, so a turn somebody else started shows too — the
   * same rule the session list's `running` follows.
   */
  running?: boolean;
  members: { agentId: string; addedBy?: string; addedAt: number }[];
}

export interface RoomMessage {
  id: string;
  gatewayId: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  text: string;
  attachments?: { name: string; mimeType: string; kind: string }[];
  at: number;
}

export interface Transcript {
  session: ChatSession | null;
  /**
   * The conversation from before the oldest turn the daemon still keeps, read from the agent's own
   * session — messages only, no steps or timings. Always empty for a room.
   */
  earlier: ChatMessage[];
  turns: ChatTurn[];
  /**
   * Room events, newest first, for the whole chat rather than this agent's side of it.
   *
   * Their own list rather than folded into `turns`: a turn has a question, an answer and steps, and
   * an event has a sentence and a kind. One shape carrying both would make every field on a turn
   * optional and every reader of a turn check which of the two it received.
   */
  events?: ChatEvent[];
  /**
   * Set when these turns span a room rather than one agent's side of a conversation.
   *
   * Sent by the daemon rather than inferred from the member list, so the client and the router
   * cannot disagree about what kind of conversation this is.
   */
  room?: Room | null;
  /**
   * What people said in this room, whether or not anybody answered.
   *
   * Rooms only, and it is what makes a room a conversation rather than a list of answered questions:
   * an untagged message produces no turn, and its bubble comes from here. A message two agents
   * answered appears here once, with each reply attached by `messageId`.
   */
  messages?: RoomMessage[];
}

export type ApprovalPreview =
  | { kind: "new_file"; path: string; lines: number; bytes: number }
  | { kind: "overwrite"; path: string; lines: number; bytes: number; wasLines: number; wasBytes: number }
  | {
      kind: "edit";
      path: string;
      added: number;
      removed: number;
      hunk: { sign: "-" | "+" | " "; text: string }[];
      clipped: boolean;
    }
  | { kind: "command"; command: string; cwd?: string; clipped: boolean; shell?: boolean }
  | { kind: "params"; json: string; clipped: boolean };

export interface ApprovalRequest {
  id: string;
  agentId: string;
  chatId: string;
  tool: string;
  params: Record<string, unknown>;
  preview?: ApprovalPreview;
  /** Whether `allow-always` would do anything. A button that is silently downgraded teaches distrust. */
  grantable?: boolean;
  reason?: string;
  requestedAt: number;
  timeoutMs: number;
  /** Not asked in its chat yet: it waits behind the question shown there, one at a time. Answerable here all the same. */
  queued?: boolean;
}

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export interface McpServer {
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authHeader?: string;
  /**
   * Whether a credential is stored for this server.
   *
   * A boolean, not the secret's name and certainly not its value: the form needs to know whether to
   * say "replace" or "add", and nothing more than that ever has to reach the browser.
   */
  hasCredential: boolean;
  /** A stdio server's credential variables, each with whether its secret is set — never the secret. Absent before 0.7.19. */
  envSecrets?: { name: string; set: boolean }[];
  /** Live state. `running` false means configured but the daemon has not started it yet. */
  connected: boolean;
  running: boolean;
  tools: number;
  schemaBytes?: number; // what its tools add to every request the agent makes (G12); absent before 0.7.9
  /** It waits for a person to log in — Connect does (0.7.19). Absent before 0.7.19. */
  needsLogin?: boolean;
  /** What its login is, when it has one — never a token. */
  login?: McpLoginView;
  /** Whether this agent uses it. */
  on?: boolean;
  /** The credential this agent uses: the library's, or its own. */
  credential?: "library" | "own";
  /** Whose login it is reached with: the library's, or this agent's own. */
  loginAs?: "library" | "own";
  /** Every agent brings its own credential: the library shares none. */
  perAgent?: boolean;
  /** On an agent's page (0.7.21): the server's tools this agent has, when it chose — absent, all of them. */
  chosenTools?: string[];
  /** When it chose: every tool the server offers, and what the ones left out would add to each request. */
  toolsTotal?: number;
  withheldBytes?: number;
  /** Names its list gives that the server does not offer. */
  unknownTools?: string[];
}

/** A server of the install's library (`GET /mcp/library`, 0.7.19): how it runs, its credential, and who uses it. */
export interface McpLibraryServer {
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authHeader?: string;
  perAgent?: boolean;
  /** The library's own credential is stored — never the secret. */
  hasCredential: boolean;
  envSecrets: { name: string; set: boolean }[];
  /** The library's login, when it has one. */
  login?: McpLoginView;
  needsLogin: boolean;
  /** Every agent, whether it uses the server, whether with its own credential, and — when on — how it is doing. */
  agents: { id: string; on: boolean; own: boolean; connected?: boolean; tools?: number; needsLogin?: boolean }[];
}

/** A remote MCP server's login, as the MCP page shows it (0.7.19). */
export interface McpLoginView {
  scope: string | null;
  /** A dashboard account's name, or `cli`. */
  loggedInBy: string;
  loggedInAt: number;
  expiresAt: number | null;
}

export interface AgentSkill {
  name: string;
  description: string;
  scope: "shared" | "project" | "builtin";
  path: string;
  /** Host software the skill's procedure names, and the subset this host does not have. */
  requires: string[];
  missing: string[];
  /** Whether this agent carries it. Everything is on until somebody switches it off. */
  enabled: boolean;
  /** Whether the agent's `skills.toml` mentions it at all — "on by default" vs "on by choice". */
  decided: boolean;
  /** `[skills] off` names it: off for every agent, whatever `enabled` says. Absent from a daemon before 0.7.10. */
  offGlobally?: boolean;
  /** False for a project skill: it is switched off by removing the root, not from here. */
  toggleable: boolean;
}

export interface McpServerInput {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Where the credential goes when it is not a bearer token, e.g. `X-Api-Key`. */
  authHeader?: string;
  /**
   * The credential itself. Stored under a generated name; never written to `config.toml`.
   *
   * Omitted on an update means "keep the stored one", so editing a URL does not require pasting the
   * key again — the same rule the gateway form follows.
   */
  token?: string;
  /**
   * A stdio server's credential variables, the whole set: a `value` to keep in the secret store, or nothing to keep the
   * one it has. Taken off here, taken off the server. Never written to `config.toml` as values.
   */
  envSecrets?: Record<string, { value?: string }>;
}

import { control, request } from "./api.client";

// Re-exported: it was declared here and callers throughout the app catch it by name.
export { ApiError } from "./api.client";
import { setupApi } from "./api.setup";
import { agentToolsApi } from "./api.agent-tools";
import { externalAgentsApi, type AgentExternal } from "./api.external-agents";
import type { AgentLook } from "./api.look";
import { mcpCatalogApi } from "./api.mcp-catalog";
import { mcpLibraryApi } from "./api.mcp-library";
export type { AgentMcpCredential, AgentMcpTool, McpLoginScope } from "./api.mcp-library";
import { updateApi } from "./api.update";
import { toolBudgetApi } from "./api.tool-budget";
import { webSearchApi } from "./api.web-search";
import { jobsApi } from "./api.jobs";
import { memoryApi, type HelperTrouble } from "./api.memory";
import { knowledgeApi } from "./api.knowledge";
import { mcpServerApi } from "./api.mcp-server";
import { peopleApi } from "./api.people";
export type { PersonRecord } from "./api.people";
import { groupsApi } from "./api.groups";
import { accessApi } from "./api.access";
export type { AccessEvent, SenderRecord } from "./api.access";
import { skillsApi } from "./api.skills";
import { secretsApi } from "./api.secrets";
import { advisoriesApi } from "./api.advisories";
import { authApi } from "./api.auth";
import { settingsApi } from "./api.settings";
import { agentsApi } from "./api.agents";
import { chatApi } from "./api.chat";
import { notesApi } from "./api.notes";
import { logsApi } from "./api.logs";
import { cronApi } from "./api.cron";
import { turnsApi } from "./api.turns";
import { tiersApi } from "./api.tiers";
import { missionsApi } from "./api.missions";
export type { MissionDetail, MissionEdit, MissionLimits, MissionSeen, MissionSettings, MissionSettingsPatch, MissionStart, MissionStatus, MissionVerb, MissionView, MissionWaitKind, Reviewing } from "./api.missions";
export type { ModelTier, ModelTiersPatch, ModelTiersView, TierHelper } from "./api.tiers";
export type { HandedOffTurn, TurnContextLine, TurnModelCall, TurnRecordDetail } from "./api.turns";
export type { CatalogSkill } from "./api.skills";
export type { CatalogDraft, CatalogInput, McpCatalogCard, McpCatalogPage } from "./api.mcp-catalog";
// Declared with the endpoints that use them; re-exported because every consumer imports from here.
export type { CronRunEntry, HeldAction, JobDeliveryMode, RunNowOutcome, JobInput, JobPatch, JobPayloadInput, JobRunSummary, JobScheduleInput, JobSummary, WebhookInput, WebhookSummary } from "./api.cron";
export type { AuditEntry, BackgroundJob, HelperBrief, JobReport, RetentionScope, StoredLogEntry, UsageRouteView } from "./api.logs";
export type { LearningMode, LearningSettings, SkillDraft, SoftwareCheck } from "./api.skills";
export type { GatewayInstance, ProviderProfileView } from "./api.settings";
export type {
  DownloadStatus,
  UpdateCheck,
  UpdateDownload,
  UpdateInstall,
  UpdatePlan,
  UpdateStatus,
} from "./api.update";

export const api = {
  health: () => request<HealthPayload>("/api/health"),
  status: () => request<StatusPayload>(`${control}/status`),

  ...setupApi,
  ...agentToolsApi,
  ...externalAgentsApi,
  ...mcpCatalogApi,
  ...mcpLibraryApi,
  ...authApi,
  ...settingsApi,
  ...agentsApi,
  ...chatApi,
  ...notesApi,
  ...logsApi,
  ...cronApi,
  ...turnsApi,

  ...skillsApi,
  ...secretsApi,
  ...advisoriesApi,

  ...updateApi,
  ...toolBudgetApi,
  ...webSearchApi,
  ...jobsApi,
  ...memoryApi,
  ...knowledgeApi,
  ...mcpServerApi,
  ...peopleApi,
  ...groupsApi,
  ...accessApi,
  ...tiersApi,
  ...missionsApi,
};
