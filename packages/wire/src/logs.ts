/**
 * What the daemon wrote down (`routes/diagnostics.ts`): the stored log, the audit trail, background jobs, usage, and how
 * long each is kept.
 */

/**
 * One line the daemon logged, as the database holds it.
 *
 * `debug` is deliberately absent from the union: it is written for somebody watching a terminal, it
 * fires per chunk of a stream, and it is not stored. It still reaches stdout and the journal.
 */
export interface StoredLogEntry {
  id: number;
  ts: number;
  level: "info" | "warn" | "error";
  component: string;
  message: string;
  data?: Record<string, unknown>;
  agentId?: string;
  chatId?: string;
}

/**
 * Which record a retention window governs.
 *
 * `jobLogs` deletes the job's row *and* its output file — the file is the thing taking up space, and
 * a row pointing at a file that is gone is worse than no row.
 */
export type RetentionScope = "log" | "audit" | "cronRuns" | "jobLogs" | "sessions";

/** One thing somebody or something caused, from the audit table. */
export interface AuditEntry {
  id: string;
  timestamp: number;
  action: string;
  /** Who caused it; absent on a row that recorded nobody. */
  actor?: string;
  agentId?: string | null;
  gatewayId?: string | null;
  chatId?: string | null;
  details?: Record<string, unknown> | null;
}

/** What a helper was handed (`delegate`'s brief). */
export interface HelperBrief {
  goal: string;
  context?: string;
  constraints?: string;
  deliverable?: string;
}

/** What a helper or an asked agent handed back: how it ended by what the daemon watched, and its own words. */
export interface JobReport {
  agentId: string;
  status: "success" | "incomplete" | "requires_human" | "failed";
  summary: string;
  files: string[];
  metrics: { toolCalls: number; steps: number; ms: number };
  reason?: string;
}

/** A background command the agent started and did not wait for — or, since 0.7.15, a helper it handed work to. */
export interface BackgroundJob {
  id: string;
  agentId: string;
  gatewayId: string;
  chatId: string;
  /** `helper: <goal>` for a helper; `ask <agent>: <task>` for an ask that moved to the background (0.7.19). */
  command: string;
  /** Absent from a daemon before 0.7.15, where every job was a command; `ask` from 0.7.19. */
  kind?: "command" | "helper" | "ask";
  cwd: string;
  status: string;
  pid: number | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  logBytes: number;
  logUpdatedAt: number | null;
  /** A helper's brief — what it was asked to do (0.7.15). Null for a command and an ask. */
  brief?: HelperBrief | null;
  /** An ask in the background: the agent asked, and what (0.7.19). */
  ask?: { agent: string; task: string } | null;
  /** What a helper or an asked agent handed back when it ended. Null for a command, and while it runs. */
  report?: JobReport | null;
  /** The turn that started it — its own turn is one that turn handed off, with this job in its cause. */
  turnId?: string | null;
  /**
   * Whether the process is genuinely still there.
   *
   * `null` when the row is not running, and worth showing separately from `status`: a row that says
   * `running` with no process behind it is the shape a daemon that died mid-job leaves.
   */
  processAlive: boolean | null;
}

/** One route a model was reached through — `GET /usage`'s `routes` (0.8.13). */
export interface UsageRouteView {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  cachedShare: number | null;
  usdPerMillion: number | null;
}
