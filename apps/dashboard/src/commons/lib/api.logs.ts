/**
 * What the daemon wrote down: the stored log, the audit trail, background jobs, usage, and how long each
 * is kept.
 *
 * Split out of `api.ts`, which had grown past the size cap with every endpoint group inline, and spread
 * into `api` like the others, so `api.x()` reads the same at every call site. The payload types are `@nouride/wire`'s.
 */

import { control, request } from "./api.client";
import type { AuditEntry, BackgroundJob, RetentionScope, StoredLogEntry, UsageRouteView } from "@nouride/wire";

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
