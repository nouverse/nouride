/**
 * What the daemon wrote down: the stored log, the audit trail, background jobs, usage, and how long each
 * is kept.
 *
 * Split out of `api.ts`, which had grown past the size cap with every endpoint group inline, and spread
 * into `api` like the others, so `api.x()` reads the same at every call site. The types these calls carry
 * are declared here and re-exported from `api.ts`, which is where every consumer imports them from.
 */

import { control, request } from "./api.client";

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
  actor: string;
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

export const logsApi = {
  /**
   * The stored log, newest first.
   *
   * `/logs` (the in-memory ring) is what `nouride logs` follows by sequence number. This is the
   * table: filtered, searchable, paged, and still there after a restart.
   */
  storedLogs: (
    options: { level?: string; component?: string; q?: string; before?: number; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.level) params.set("level", options.level);
    if (options.component) params.set("component", options.component);
    if (options.q?.trim()) params.set("q", options.q.trim());
    if (options.before) params.set("before", String(options.before));
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return request<{
      entries: StoredLogEntry[];
      total: number;
      nextBefore?: number;
      components: { component: string; entries: number }[];
      span: { oldest: number | null; newest: number | null };
      retentionDays: number;
    }>(`${control}/logs/stored${query ? `?${query}` : ""}`);
  },

  /**
   * How long this install keeps each record it writes down: the daemon's log (`log`), the audit log
   * (`audit`), scheduled runs (`cronRuns`), background jobs' output (`jobLogs`) and conversations
   * (`sessions`).
   *
   * One call for all of them, because it is one question asked of each — and they hold deliberately
   * different answers.
   */
  retention: () => request<{ windows: Record<RetentionScope, number> }>(`${control}/retention`),

  setRetention: (scope: RetentionScope, days: number) =>
    request<{ windows: Record<RetentionScope, number> }>(`${control}/retention/${scope}`, {
      method: "PUT",
      body: JSON.stringify({ days }),
      headers: { "content-type": "application/json" },
    }),

  /** Who made what happen. One row per decision, kept far longer than the log. */
  audit: (limit = 200) => request<{ entries: AuditEntry[] }>(`${control}/audit?limit=${limit}`),

  /** Background commands — the ones an agent started with `exec background: true`. */
  backgroundJobs: () => request<{ jobs: BackgroundJob[] }>(`${control}/jobs`),

  usage: (days = 1) =>
    request<{
      days: number;
      total: {
        usd: number;
        inputTokens: number;
        outputTokens: number;
        /** Of `inputTokens`, how many the provider served from its cache. */
        cachedInputTokens: number;
        /** Of `inputTokens`, how many were written to the cache — billed at a 25% premium. */
        cacheCreationInputTokens: number;
        unpricedRequests: number;
        requests: number;
      };
      /** Days the routes are added up over: a week at least (TOKEN_SAVINGS §3.1). */
      routeDays?: number;
      /** Each profile and model, with its cached share — null where the provider never said — and $ a million input. */
      routes?: UsageRouteView[];
      /** A route of a model caching far below another route of it, said with what each costs (0.8.13). */
      cacheWarnings?: { model: string; said: string }[];
    }>(`${control}/usage?days=${days}`),
};
