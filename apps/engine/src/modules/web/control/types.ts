/**
 * What the control API is handed, and the app type every route module registers on.
 *
 * `ControlDeps` is a bag of optional collaborators on purpose: a daemon that never serves the
 * dashboard has no `users` store, and a test harness that only runs turns has no `grants`. Each
 * route answers 501 for the surface it cannot reach rather than the process refusing to boot without
 * a store it will never use.
 */

import type { NotesPort } from "@/modules/notes/store.ts";
import type { Missions } from "@/modules/missions/missions.ts";
import type { ExternalAgents } from "@/modules/external-agents/index.ts";
import type { McpCatalog } from "@/modules/mcp-registry/index.ts";
import type { McpLogins } from "@/modules/mcp-oauth/index.ts";
import type { McpServerStatus } from "@/modules/tools/mcp.ts";
import type { McpToolRow } from "@/modules/tools/mcp-tools.ts";
import type { Memory } from "@/modules/memory/index.ts";
import type { MemoryPass } from "@/boot/memory-pass.ts";
import type { McpTokenPort } from "@/modules/mcp-server/tokens.store.ts";
import type { Hono } from "hono";
import type {LoadedAgent, Skill } from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import type { ReflectionEngine } from "@/modules/reflection/index.ts";
import type { SkillHub } from "@/modules/skills-hub/index.ts";
import type { ToolGrantsPort } from "@/modules/tools/tool-grants.store.ts";
import type { GrantsPort } from "@/modules/tools/grants.store.ts";
import type { AccessPort } from "@/modules/access/access.store.ts";
import type { AutoApprovePort } from "@/modules/tools/auto-approve.store.ts";
import type { JobsPort } from "@/modules/jobs/jobs.store.ts";
import type { CronPort } from "@/modules/cron/cron.store.ts";
import type { CronScheduler } from "@/modules/cron/scheduler.ts";
import type { HookTests } from "@/modules/web/hook-reach.ts";
import type { ProposalCards } from "@/modules/cron/proposal-cards.ts";
import type { Notifier } from "@/commons/notify.ts";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { LogBuffer } from "@/commons/log-buffer.ts";
import type { LogsPort } from "@/commons/logs.store.ts";
import type { StateRows } from "@/commons/daemon-state.store.ts";
import type { DaemonContext } from "@/commons/context.ts";
import type { CredentialSharing } from "@/boot/embedded-gateway.ts";
import type { LocalGateway } from "@/modules/gateways/local.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { Pipeline } from "@/modules/pipeline/index.ts";
import type { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import type { SecretStore } from "@nouride/secrets";
import type { Principal } from "@/modules/users/auth.ts";
import type { UsersPort } from "@/modules/users/users.store.ts";
import type { SetupService } from "@/modules/setup/service.ts";
import type { SettingsService } from "@/modules/config/settings/index.ts";
import type { FileService } from "@/modules/setup/files.ts";
import type { SkillRoots } from "@/modules/setup/skill-roots.ts";
import type { SessionsPort } from "@/modules/sessions/sessions.store.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import type { TurnInspector } from "@/modules/turns/inspection.store.ts";
import type { EventsPort } from "@/modules/events/events.store.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import type { ChatEventsPort } from "@/modules/chat-events/chat-events.store.ts";
import type { RoomsPort } from "@/modules/rooms/rooms.store.ts";
import type { RoomMessagesPort } from "@/modules/chat-events/room-messages.store.ts";
import type { ChatAttachmentsPort } from "@/modules/attachments/chat-attachments.store.ts";
import type { OpenStreams } from "./streams.ts";
import type { UploadStore } from "./uploads.ts";
import type { ApprovalReach } from "@/modules/tools/reachability.ts";
import type { DaemonRestart } from "@/modules/update/restart.ts";
import type { UpdateOps } from "./routes/update.ts";

/**
 * What the server knows about the connection, passed down as Hono's environment.
 *
 * Not a header: see the note at the `serveHttp` call in `web/server.ts`. Null where the platform
 * cannot say, and in a test that calls `app.request()` without one — a rule keyed on it has to
 * handle that rather than assume an address is always there.
 */
export interface ControlEnv {
  clientAddress: string | null;
  /** Keep this request's connection open past the idle timeout (`RequestInfo.keepOpen`); absent in a test. */
  keepOpen?: (seconds: number) => void;
}

/**
 * The sub-app every route module registers on.
 *
 * Typed with `principal` in `Variables` so a handler reads `c.get("principal")` and gets a
 * `Principal`, not `unknown` — the guard in `guard.ts` is what puts it there. `Bindings` carries
 * the connection's own facts, which no header can be trusted for.
 */
export type ControlApp = Hono<{ Variables: { principal: Principal }; Bindings: ControlEnv }>;

export interface ControlDeps {
  ctx: DaemonContext;
  token: string;
  /**
   * How the bundled gateway came to hold this daemon's admin credential — see `CredentialSharing`.
   *
   * A boot fact, not a config one, and it cannot be derived later: it depends on what was in the
   * environment and what was in the users table at the moment the gateway came up. Absent when the
   * gateway is not hosted here, or came up holding a password of its own, and the wizard must not
   * claim otherwise.
   */
  sharedGatewayCredential?: CredentialSharing;
  /**
   * Where the bundled gateway's dashboard is served on this port (`/llm-gateway`), when it is.
   *
   * What the dashboard draws its LLM Gateway page and the wizard's sign-in step on. Absent on every
   * build and config that does not host the gateway here — and on one that hosts it with no users
   * store to check a session against, which cannot mount it.
   */
  llmGatewayMount?: string;
  /**
   * Whether that dashboard can be shown inside this one — `EmbeddedGateway.dashboardEmbeddable`.
   * A function, so a bundle replaced under a running daemon is read as it is now.
   */
  llmGatewayDashboard?: () => boolean;
  /**
   * Named credentials, for the one route that needs one.
   *
   * `auth/oauth/callback` has to present a client secret to the identity provider, and config holds
   * the secret's *name* rather than its value — the same rule a provider profile's `apiKeySecret`
   * follows. Nothing else in the control plane reads this; it is here rather than reached through
   * `settings` because a route that needs a credential should say so in its dependencies.
   */
  secrets: SecretStore;
  pipeline: Pipeline;
  registry: AgentRegistry;
  providers: ProviderRegistry;
  approvals: SqliteApprovalGate;
  /** Absent in processes that run turns without durable grants (tests, one-shot tools). */
  grants?: GrantsPort;
  /** Directory-scoped grants for tools that are not `exec`. Listed alongside them, never merged. */
  toolGrants?: ToolGrantsPort;
  /** Who may talk to the daemon. */
  access?: AccessPort;
  /** Senders who switched approval off — dropped with their access (`AutoApprove.forget`). */
  autoApprove?: AutoApprovePort;
  /** Tokens for Nouride's MCP server (`/mcp`). */
  mcpTokens?: McpTokenPort;
  /** What is remembered about people. Absent in harnesses without it, and the memory routes answer 503. */
  memory?: Memory;
  /** Memory's nightly pass: run on demand, reported on, and the model call forgetting someone needs. Absent where it is not scheduled. */
  memoryPass?: Pick<MemoryPass, "run" | "status" | "ask">;
  /** Background jobs. */
  jobs?: JobsPort;
  /** For telling a newly approved sender they are in. */
  notifier?: Notifier;
  audit: AuditPort;
  /** Recent log lines, so `nouride logs` works where there is no journal — and works remotely. */
  logs?: LogBuffer;
  /**
   * The same lines on disk, for System Logs.
   *
   * Separate from `logs` rather than replacing it: the ring is what a follower polls by sequence
   * number, and the table is what somebody scrolls, searches and still finds after a restart. Absent
   * in a process with no database of its own.
   */
  logStore?: LogsPort;
  /** MCP connections, for `nouride mcp` — with what each server's tools cost a request. Absent when no agent declared a server. */
  mcp?: { status(): McpServerStatus[]; toolList(agentId: string, server: string): McpToolRow[] | undefined };
  /** Remote MCP servers' logins (0.7.19): Connect on the MCP page, `nouride mcp login`. Absent: those routes answer 501. */
  mcpLogins?: McpLogins;
  /** Present only when the local gateway is registered. */
  local?: LocalGateway;
  /** Asks the daemon to stop; the supervisor is expected to bring it back. */
  requestRestart?: (reason: string) => void;
  /** When each agent was first seen (0.8.1): its row's `since` in `/status`. Absent: null for every agent. */
  agentsSeen?: { since(id: string): number | null };
  /** The daemon's own state rows (`daemon_state`, 0.8.18): what the last boot advised, for `/advisories`. Absent: none. */
  state?: Pick<StateRows, "get">;
  /** Who, if anyone, will respawn this process — so `/restart` can refuse to be a stop button. */
  supervisor?: () => { kind: string; restartsOnExit: boolean };
  /** `POST /restart`: waits for idle, and arms whatever follow-up was asked for — `modules/update/restart.ts`. */
  restart?: Pick<DaemonRestart, "request">;
  /** What the `/update` routes do to the update module; the module itself when absent — see `routes/update.ts`. */
  updates?: UpdateOps;
  /** Dashboard accounts. Absent in processes that only ever speak to the CLI. */
  users?: UsersPort;
  /** First-run setup. Absent when the dashboard is not served. */
  setup?: SetupService;
  /** Gateway and provider editing. Absent when there is no config file to write. */
  settings?: SettingsService;
  /** Persona and config file editing. */
  files?: FileService;
  /** An agent's skill roots, listed, added and removed (0.8.24, `routes/skill-roots.ts`). */
  skillRoots?: SkillRoots;
  /** Conversations, for the dashboard's chat view. */
  sessions?: SessionsPort;
  /** Each conversation's work notes, shown and edited beside it (`routes/notes.ts`). */
  notes?: NotesPort;
  /** The missions (0.8.0, `routes/missions.ts`). Absent where none are run. */
  missions?: Missions;
  /** External agents' CLIs: the scan, and an agent's sign-in (0.8.1, `routes/external-agents.ts`). */
  externalAgents?: ExternalAgents;
  /**
   * What each turn did, for the same view.
   *
   * The dashboard's transcript is built from these rather than from the session's messages: a record
   * carries the steps, the clock and the partial answer, and it exists while the turn is still
   * running — which is what lets a page that was refreshed rejoin a turn instead of re-sending it.
   */
  turns?: TurnsPort;
  /** One turn read whole — its calls, cost, latency and audit rows, joined by its id (`nouride turns show`). */
  turnInspector?: TurnInspector;
  /** What turns do, as one stream — read a page at a time, or followed (`routes/events.ts`). */
  events?: EventsPort;
  /** The event streams open now, which a shutdown ends before stopping the server (`streams.ts`). */
  streams?: OpenStreams;
  /**
   * Where a browser's files land before a turn reads them.
   *
   * Also the boundary that makes a browser's attachment path trustworthy — see `uploads.ts`. Absent
   * in a daemon that serves no dashboard, and then attaching from one is refused rather than
   * half-working.
   */
  uploads?: UploadStore;
  /** Token and cost records. */
  usage?: UsagePort;
  /** Things that happened *to* a conversation — see `ChatEventStore`. */
  chatEvents?: ChatEventsPort;
  /** Who is in a room. Absent for a chat means nothing knows — see the store's own note. */
  rooms?: RoomsPort;
  /** What people said in a room. */
  roomMessages?: RoomMessagesPort;
  /** The conversation's file list, so deleting a room takes its refs with it. */
  attachmentIndex?: ChatAttachmentsPort;
  /** Records that somebody is watching for approvals. */
  reach?: ApprovalReach;
  /** Scheduled jobs. Absent when `[cron] enabled = false`. */
  cron?: {
    store: CronPort;
    scheduler: CronScheduler;
    timezone: string;
    tests?: HookTests;
    /** A proposal answered here: its card in the chat says so (0.8.0). */
    proposals?: Pick<ProposalCards, "settled">;
  };
  /**
   * `skills/` beside the executable, when this build ships built-in skills.
   *
   * Passed in rather than re-resolved here: a route that searched the filesystem for it would answer
   * differently from the loader if the daemon's cwd ever differed, and "why is this skill in the
   * prompt but not in the dashboard" is a bad afternoon.
   */
  builtinSkillsDir?: string;
  /** Scans project skill roots, so `/skills` can show what a turn would actually see. */
  projectSkills?: { forAgent(agent: LoadedAgent): Promise<Skill[]> };
  /**
   * Skill drafts and the two decisions on them. Absent when `[skills.learning] mode = "off"`.
   *
   * The drafts routes answer 200 with `enabled: false` rather than 501 for the *listing*, so the
   * Workshop can render "self-improvement is off" instead of an error nobody can act on. Everything
   * that writes still refuses outright.
   */
  reflection?: ReflectionEngine;
  /** Search and install skills from hubs, into the pending queue. Absent in tests that do not need it. */
  skillHub?: SkillHub;
  /** Nouverse's MCP catalog — `routes/mcp-catalog.ts`. Absent (turned off): the routes answer 501. */
  mcpCatalog?: McpCatalog;
}
