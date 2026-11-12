import type { AgentLook, AgentStatus, ApprovalRequest, Job, JobRun, Person, Session } from "@nouride/shared";
import type {
  BackgroundJob,
  CatalogDraft,
  CliLoginView,
  CliRoom,
  MissionView as WireMissionView,
  NotesPlan,
  ScannedCli,
  SenderRecord,
  SkillDraft,
  WebhookReach,
} from "@nouride/wire";
import type { AtOnce, HelperTroubleLine, AuditLine, BufferedLog, LocalTurnResult, ExecGrantRecord, ToolGrantRecord } from "./records.ts";

/**
 * What the CLI expects each control route to answer.
 *
 * These are the CLI's **assumptions**, written down. Every method on `Client` used to return
 * `Promise<any>` — the one annotation worse than none, because `const { secrets } = await
 * client.get("/secrets")` compiled whatever the route actually sent. Two separately built artefacts
 * talk over this boundary and are upgraded independently, so it was the only interface in the tree
 * with no checking at all: a renamed field became `undefined` printed to a terminal, found by
 * reading the output.
 *
 * ## Why the shapes live here and not in the routes
 *
 * A route's response is built inline with `c.json({…})` and is the daemon's business; several send
 * more than any caller reads. What the CLI needs is not the daemon's type but a statement of what it
 * *depends on*, which is a smaller and more useful thing: it makes the dependency reviewable, and a
 * field that stops arriving fails at the call site instead of at the pixel.
 *
 * Declared as narrowly as the code actually reads. Adding a field here should mean the CLI started
 * using it.
 */

/**
 * `GET /status` — read by `status`, `agents`, `gateway` and `doctor`.
 *
 * `gateways` is an **array** here and a `Record` on `/health`. Two routes, two shapes, one word —
 * and writing this type from the wrong one was the first thing the compiler caught, because
 * `gateway.ts` iterates it and `health.ts` keys it. Under `any` both spellings compiled and only one
 * of them would have run.
 */
export interface StatusResponse {
  status: string;
  uptime: number;
  /** How much work runs at once, and whether a setting or the machine decided it. Absent from an older daemon. */
  atOnce?: AtOnce;
  /** Absent from a daemon older than 0.7.0. */
  supervisor?: { kind: string; restartsOnExit: boolean };
  configSource: string;
  dataDir: string;
  orchestrator: string | null;
  agents: {
    id: string;
    displayName: string;
    enabled: boolean;
    state: string;
    /** What it is doing now (0.7.18). Absent from an older daemon. */
    activity?: AgentStatus;
    provider: string;
    model: string;
    /** Who answers when the model cannot, in order (0.8.0), empty for none. */
    fallbacks?: { provider: string; model: string }[];
    /** What its turns are budgeted at, and where the number comes from. Absent from a daemon before 0.7.13. */
    contextWindow?: { tokens: number; source: "pack" | "gateway" | "table" | "default" };
    tools: string[];
    approvals: string;
    /** What the pack pins, or null when it follows the daemon default. */
    maxToolIterations: number | null;
    /** The same, for the wall clock, in seconds. */
    maxTurnSeconds: number | null;
    skills: string[];
    workspaceRoots: { path: string; exists: boolean }[];
    /**
     * An external agent's coding CLI and profile (0.8.1), with the CLI's name, the model its pack sets (null: the CLI's
     * default) and that default as a session named it. Absent for any other, and from an older daemon.
     */
    external?: { cli: string; profile: string; name?: string; model?: string | null; cliDefault?: string | null };
    /** The parts of its cat its pack picks (0.8.1). */
    look?: AgentLook;
  }[];
  failures: { id: string; error: string }[];
  providers: { name: string; kind: string; baseUrl: string; hasCredential: boolean }[];
  gateways: { id: string; platform: string; status: string }[];
  queue: { running: number; waiting: number };
  pendingApprovals: number;
  /** What compaction and the memory pass ran into with their models in the last day (`helper-trouble.ts`). Absent before 0.7.25. */
  helpers?: HelperTroubleLine[];
}

/**
 * `GET /logs` — the in-memory ring `nouride logs` reads, following or not.
 *
 * `BufferedLog`, the buffer's own type, not the log *store*'s. The two are easy to confuse and the
 * daemon holds both: `deps.logs` is the ring (`timestamp` as an ISO string, a `seq`), `deps.logStore`
 * is the SQLite table (`ts` as epoch millis). Writing this type from the store's shape had me
 * believing `nouride logs` printed a broken timestamp; running it on the box showed `19:00:56` and
 * the mistake was mine.
 */
export interface LogsResponse {
  entries: BufferedLog[];
  /** Sequence numbers, so a follower can tell a quiet period from a gap it fell behind. */
  oldest: number;
  latest: number;
}

/**
 * One skill as the routes render it, with every agent's switch on it.
 *
 * `missing` is host software the skill asks for and this box does not have — checked once for the
 * whole daemon. `missingTools` is per agent, because two agents on one machine can disagree about a
 * tool while agreeing about every binary.
 */
export interface SkillRow {
  name: string;
  description: string;
  scope: string;
  path: string;
  requires: string[];
  missing: string[];
  needsTools: string[];
  agents: {
    id: string;
    displayName: string;
    enabled: boolean;
    missingTools: string[];
    /** A coding CLI's agent: tools no coding CLI is given, so the skill is not its (0.8.13). */
    notForCli?: string[];
    /** Whether the pack said anything, so "on by default" reads differently from "switched on". */
    decided: boolean;
  }[];
  lastUsedAt: number | null;
}

/**
 * `GET /skills/catalog` — soft-fetched, because a daemon too old to have the route answers 404.
 *
 * Includes skills switched off everywhere, which `/skills` cannot show: that route lists what each
 * agent is *offered*, so a skill nobody carries is invisible there.
 */
export interface SkillCatalogResponse {
  skills: SkillRow[];
  /** Every program any skill asks for, checked once rather than per row. */
  software: { name: string; present: boolean }[];
  poolDir: string;
  editable: boolean;
}

/** `GET /skills` — what each agent is actually offered. */
export interface SkillsByAgentResponse {
  agents: {
    agentId: string;
    skills: {
      name: string;
      description: string;
      scope: string;
      path: string;
      requires: string[];
      missing: string[];
      needsTools: string[];
      missingTools: string[];
      notForCli?: string[];
      lastUsedAt: number | null;
    }[];
  }[];
}

/** `GET /skills/drafts` — the reflection loop's proposals, waiting for a human. */
export interface DraftListResponse {
  enabled: boolean;
  pending: SkillDraft[];
  /** Decided rows only; the pending ones are above and repeating them doubles every table row. */
  recent: SkillDraft[];
}

/**
 * One scheduled job as the routes send it: the daemon's own `Job`, plus the one field they add.
 *
 * Reusing `Job` rather than restating it, which is what the first draft of this file did — and the
 * compiler caught it missing `describes`, `target`, `runCount`, `failCount` and `session`, all of
 * which the CLI prints. A hand-written copy of a type that already exists is a copy that is wrong
 * from the first commit.
 *
 * `describes` is the daemon rendering the trigger into a sentence (`describeTrigger`), so two
 * clients cannot disagree about what "every weekday at 07:00" means.
 */
export type CronJobRow = Job & { describes: string };

/** What `POST /cron/:id/run` reports about the run it just did. */
export interface CronRunOutcome {
  status: string;
  result?: string | null;
}

export interface CronListResponse {
  jobs: CronJobRow[];
  timezone: string;
}

export interface CronDetailResponse {
  job: CronJobRow;
  runs: JobRun[];
}

/**
 * `GET /jobs` and `GET /jobs/:id/log` — background commands.
 *
 * A job as `@nouride/wire` says it, which the store's own `JobSnapshot` is held to (`check-seams`).
 */
export interface JobListResponse {
  jobs: BackgroundJob[];
}

export interface JobLogResponse {
  id: string;
  job: BackgroundJob;
  /** Bounded server-side — a build log is megabytes and this is a JSON body. */
  log: string;
}

/**
 * What a route answers when the CLI only needs to know it worked.
 *
 * Deliberately loose: several of these routes echo back a field or two the caller prints (`revoked`,
 * `restarted`, `note`), and enumerating each would be a type per verb for one line of output each.
 * What is pinned is the part that matters — a client that reads `result.ok` cannot silently be
 * reading something that was never sent.
 */
export interface AckResponse {
  ok?: boolean;
  error?: string;
  note?: string;
  /** Rows affected, for the revoke and prune verbs that report a count. */
  revoked?: number;
  removed?: number;
  restarted?: boolean;
  /** Set by the routes that changed config the daemon only reads at boot. */
  restartRequired?: boolean;
  /** `POST /access/approve` echoes the sender it just let in. */
  sender?: SenderRecord;
  /** `POST /approvals/:id/:decision` echoes what was decided. */
  decision?: string;
  /** `PUT /secrets/:name` says when an env var will win over what was just stored. */
  shadowedByEnv?: boolean;
  id?: string;
  name?: string;
  status?: string;
  mode?: string;
}

/** `GET /access` — who may talk to this daemon, and who is waiting to be let in. */
export interface AccessResponse {
  mode: string;
  senders: SenderRecord[];
}

export type SenderRow = SenderRecord;

/** `GET /approvals` — tool calls waiting for a human. */
export interface ApprovalsResponse {
  pending: ApprovalRequest[];
  /** With `?all=1`: the answered, expired and dropped ones the gate still keeps, newest first. */
  settled?: ApprovalRequest[];
}

/** `GET /approvals/:id` — one request, whatever became of it. */
export interface ApprovalResponse {
  approval: ApprovalRequest;
}

/**
 * `GET /audit` — what the agents did.
 *
 * A row with its `timestamp`: the store's own `AuditEntry` omits it, and `recent()` reads the column and hands it
 * back all the same. That is a gap in the store's type rather than in this one (`AuditLine`).
 */
export interface AuditResponse {
  entries: AuditLine[];
}

/** `GET /grants` — durable permissions, exec commands and whole tools. */
export interface GrantsResponse {
  grants: ExecGrantRecord[];
  toolGrants: ToolGrantRecord[];
}

/** `GET /agents/:id/mcp/:name/tools` (0.7.21): a server's tools for one agent, and whether it has each. */
export interface McpToolsResponse {
  tools: { name: string; description: string; bytes?: number; on: boolean }[];
  /** No `tools` list: the agent has every one. */
  all: boolean;
  /** Names its list gives that the server does not offer. */
  unknown?: string[];
}

/** `GET /mcp` — which servers connected, how many tools each offered, and what their schemas cost every request. */
export interface McpResponse {
  /** `schemaBytes` is absent from a daemon before 0.7.9, `needsLogin` from one before 0.7.19. */
  servers: {
    agentId: string;
    server: string;
    connected: boolean;
    tools: number;
    schemaBytes?: number;
    needsLogin?: boolean;
    /** Set when the agent chose the server's tools (0.7.21): every tool it offers, and what the ones left out cost. */
    toolsTotal?: number;
    withheldBytes?: number;
    /** Names the agent's `tools` list gives that the server does not offer. */
    unknownTools?: string[];
  }[];
}

/** `POST /agents/:id/mcp/:server/oauth/start` — the address a person opens to log the server in. */
export interface McpLoginStartResponse {
  url: string;
}

/** `POST /mcp/oauth/finish` — whose login of which server is made now (`shared`: the library's), and its scope. */
export interface McpLoginFinishResponse {
  ok: true;
  holder: string;
  server: string;
  scope?: string;
}

/** `GET /mcp/library` — the install's MCP servers, and each agent's word on them (0.7.19). Never a secret or its name. */
export interface McpLibraryResponse {
  /** Why `agents/mcp.toml` does not load, when it does not. */
  error?: string;
  servers: {
    name: string;
    transport: "stdio" | "sse" | "streamable-http";
    command?: string;
    args?: string[];
    url?: string;
    perAgent?: boolean;
    hasCredential: boolean;
    envSecrets: { name: string; set: boolean }[];
    login?: { scope: string | null; loggedInBy: string; loggedInAt: number; expiresAt: number | null };
    needsLogin: boolean;
    agents: { id: string; on: boolean; own: boolean; connected?: boolean; tools?: number; needsLogin?: boolean }[];
  }[];
}

/** `GET /people` — the `[[people]]` table the agent reads to know who is speaking. */
export interface PeopleResponse {
  people: Person[];
}

/** `GET /providers` — the profiles, and whether this daemon may edit them. */
export interface ProvidersResponse {
  providers: { name: string; kind: string; baseUrl: string; hasKey?: boolean }[];
  editable: boolean;
}

/** `POST /providers/probe` — a credential tried against a real endpoint before it is stored. */
export interface ProbeResponse {
  ok: boolean;
  error?: string;
  models?: string[];
  note?: string;
}

/**
 * `GET /sessions` — the conversation list.
 *
 * The store's `Session`, plus the two things the route computes across stores: whether a turn is
 * running in it, and the first question as a title.
 */
export interface SessionListResponse {
  sessions: (Session & { running: boolean; title?: string })[];
  total: number;
}

/**
 * One webhook trigger, as `webhookView` sends it: the job, plus where to POST.
 *
 * `urlGuessed` says the daemon inferred its own public address rather than being told — which is the
 * difference between a URL somebody can paste and one that will only work from this machine, and the
 * CLI warns about it.
 */
export type WebhookRow = Job & {
  path: string;
  url: string;
  urlGuessed: boolean;
  reach: WebhookReach;
};

/**
 * `POST /message` — one message injected through the local gateway, and what came back.
 *
 * `LocalTurnResult` plus the note the route adds. Not `ChatResponse` from `@nouride/shared`, which
 * is a *provider's* answer and happens to sound right — the first draft of this used it and the
 * compiler caught all three fields missing. An adjacent name is worse than no name.
 */
export type MessageResponse = LocalTurnResult & {
  /** Why nothing answered, when nothing did. An empty reply list is a decision, not a failure. */
  note?: string;
};

/** `GET /mcp/catalog` — Nouverse's MCP catalog, as the daemon reads it (`routes/mcp-catalog.ts`). */
export interface McpCatalogCard {
  name: string;
  version: string;
  title?: string;
  description: string;
  /** Its website, or else its repository. */
  link?: string;
  publisher: string;
  runsVia?: "remote" | "npm" | "pypi" | "docker";
  needs?: string[];
  unsupported?: string;
  /** Why, for a badge: the programs it needs (any one), why an installed one cannot be used, or the forms it comes in. */
  blocked?: { needs: ("npx" | "uvx" | "docker")[]; unusable?: Partial<Record<"npx" | "uvx" | "docker", string>>; forms?: string[]; label: string };
  /** Its place in Nouverse's list, when pinned there. */
  pinned?: number;
}

export interface McpCatalogResponse {
  entries: McpCatalogCard[];
  /** How many match in all. */
  total: number;
  /** When Nouverse last brought its copy of the registry up to date (ISO). */
  syncedAt: string | null;
}

/** `GET /mcp/catalog/entry` — one entry, and the form adding it would fill in. */
export interface McpCatalogEntryResponse extends McpCatalogCard {
  result?: { draft: CatalogDraft } | { unsupported: string; blocked: NonNullable<McpCatalogCard["blocked"]> };
}

/** A mission as `/missions` sends it: the record, what a person sees it as, and the time it has worked (0.8.0). */
export type MissionView = WireMissionView;

export interface MissionListResponse {
  missions: MissionView[];
  /** For an admin who asked for their own: how many more are other people's or nobody's. */
  elsewhere?: number;
}

export interface MissionDetailResponse {
  mission: MissionView;
  sessionId: string;
  plan: NotesPlan | null;
  parked: ApprovalRequest[];
  /** The reviewer at work (0.8.10): which pass, of how many, since when. */
  reviewing?: { pass: number; of: number; since: number };
}

export interface MissionResponse {
  mission: MissionView;
  /** `tell` (0.8.10): where the words went, for the person. */
  said?: string;
}

/** `DELETE /missions/:id` (0.8.13): the mission gone, and how many turn records went with its conversation. */
export interface MissionDeletedResponse {
  ok: true;
  mission: string;
  turns: number;
}

/** `GET /external-clis` — which coding CLIs this box has (`nouride agents scan`). */
export interface ExternalClisResponse {
  room: CliRoom;
  clis: ScannedCli[];
}

/** `POST /agents/:id/cli/login`, and `…/answer` — the sign-in as the terminal shows it. */
export interface CliLoginResponse {
  login: CliLoginView;
}

/** `GET /agents/:id/cli` — an external agent's CLI, and its sign-in where one was started. */
export interface AgentCliResponse {
  cli: string;
  unavailable: string | null;
  login: CliLoginView | null;
}
