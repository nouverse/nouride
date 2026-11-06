/**
 * `memory_analyze` — counts a search answers badly — `docs/SPEC.md` §12.3.
 *
 * "What have we talked about most this month", "when did Bali come up", "how often do we work on the
 * homelab, by week", "which agent did I talk to most". Structured intents only, never free text: the
 * model turns a question into arguments, and this answers from the index, deterministically, over the
 * episodes the audience may see (`EpisodeFilter.scope`).
 */

import type { MemoryAnalyticsPort, Period } from "./memory-analytics.store.ts";
import type { EpisodeFilter } from "./episode-filter.ts";

export type AnalyzeField = "tags" | "people";

export type AnalyzeRequest =
  | { intent: "top"; field: AnalyzeField; limit?: number }
  | { intent: "dates"; field: AnalyzeField; value: string }
  | { intent: "count"; period: Period; field?: AnalyzeField; value?: string }
  | { intent: "activity" }
  | { intent: "importance"; field?: AnalyzeField; value?: string };

/** Case and `#` do not matter: `#Bali` and `bali` are one tag. */
function normal(value: string): string {
  return value.replace(/^#/, "").trim().toLowerCase();
}

function narrowed(filter: EpisodeFilter, field?: AnalyzeField, value?: string): EpisodeFilter {
  if (!field || !value) return filter;
  return field === "tags" ? { ...filter, tags: [normal(value)] } : { ...filter, people: [normal(value)] };
}

function about(field?: AnalyzeField, value?: string): string {
  return field && value ? ` about ${field === "tags" ? "#" : ""}${normal(value)}` : "";
}

/** The answer as text a model reads — a few lines, never a table it has to parse. */
export function analyze(index: MemoryAnalyticsPort, filter: EpisodeFilter, request: AnalyzeRequest, span: string): string {
  switch (request.intent) {
    case "top": {
      const limit = Math.min(50, Math.max(1, Math.floor(request.limit ?? 10)));
      const top = request.field === "tags" ? index.topTags(filter, limit) : index.topPeople(filter, limit);
      if (top.length === 0) return `No ${request.field} recorded ${span} in what this chat may see.`;
      return [`Most frequent ${request.field} ${span} (conversations):`, ...top.map((row) => `- ${row.value}: ${row.n}`)].join("\n");
    }
    case "dates": {
      const days = index.countBy(narrowed(filter, request.field, request.value), "day");
      if (days.length === 0) return `${normal(request.value)} did not come up ${span} in what this chat may see.`;
      return [`${normal(request.value)} came up on ${days.length} day(s) ${span}:`, ...days.map((row) => `- ${row.bucket}${row.n > 1 ? ` (${row.n} conversations)` : ""}`)].join("\n");
    }
    case "count": {
      const buckets = index.countBy(narrowed(filter, request.field, request.value), request.period);
      const total = buckets.reduce((sum, row) => sum + row.n, 0);
      return [`Conversations${about(request.field, request.value)} per ${request.period} ${span}: ${total} in all.`, ...buckets.map((row) => `- ${row.bucket}: ${row.n}`)].join("\n");
    }
    case "activity": {
      const agents = index.byAgent(filter);
      if (agents.length === 0) return `No conversations ${span} in what this chat may see.`;
      return [`Conversations per agent ${span}:`, ...agents.map((row) => `- ${row.value}: ${row.n}`)].join("\n");
    }
    case "importance": {
      const result = index.importance(narrowed(filter, request.field, request.value));
      if (result.n === 0 || result.average === null) return `No filed conversations${about(request.field, request.value)} ${span}.`;
      return `Average importance${about(request.field, request.value)} ${span}: ${result.average.toFixed(1)} of 5, over ${result.n} conversation(s); ${result.high} rated 4 or 5.`;
    }
  }
}
