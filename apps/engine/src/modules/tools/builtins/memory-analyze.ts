/**
 * `memory_analyze` — counts over past conversations (`modules/memory/analyze.ts`).
 *
 * Its own file because `memory.ts` is the memory tools' read and write path and is already long; this
 * one only asks the memory module a question and returns its answer.
 */

import type { Tool, ToolResult } from "@nouride/shared";
import type { AnalyzeField, AnalyzeRequest, Period } from "@/modules/memory/index.ts";
import { speakerOf, type MemoryToolsDeps } from "./memory.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS: readonly AnalyzeField[] = ["tags", "people"];
const PERIODS: readonly Period[] = ["day", "week", "month"];

/** The model's arguments as a request, or what is wrong with them — said so it can try again. */
function requestOf(args: Record<string, unknown>): AnalyzeRequest | string {
  const field = typeof args.field === "string" && FIELDS.includes(args.field as AnalyzeField) ? (args.field as AnalyzeField) : undefined;
  const value = typeof args.value === "string" && args.value.trim() ? args.value.trim() : undefined;
  if (args.field !== undefined && !field) return "`field` is tags or people.";
  if (value && !field) return "`value` needs a `field`: tags or people.";
  switch (args.intent) {
    case "top":
      return field ? { intent: "top", field, ...(typeof args.limit === "number" ? { limit: args.limit } : {}) } : "`top` needs `field`: tags or people.";
    case "dates":
      return field && value ? { intent: "dates", field, value } : "`dates` needs `field` and `value`, e.g. field tags, value travel.";
    case "count": {
      const period = typeof args.period === "string" && PERIODS.includes(args.period as Period) ? (args.period as Period) : "week";
      return { intent: "count", period, ...(field && value ? { field, value } : {}) };
    }
    case "activity":
      return { intent: "activity" };
    case "importance":
      return { intent: "importance", ...(field && value ? { field, value } : {}) };
    default:
      return "`intent` is one of top, dates, count, activity, importance.";
  }
}

export function createMemoryAnalyzeTool(memory: Pick<MemoryToolsDeps, "analyze">): Tool {
  return {
    requiresApproval: false,
    parallelSafe: true,
    definition: {
      name: "memory_analyze",
      description:
        "Count over past conversations, for questions a search answers badly: what came up most " +
        "(top), when something came up (dates), how often over time (count, per day, week or month), " +
        "which agent was talked to most (activity), how important it tended to be (importance). " +
        "Filter by a tag or a person. Only what this chat may see is counted.",
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            enum: ["top", "dates", "count", "activity", "importance"],
            description:
              "top: most frequent tags or people (needs field). dates: when one tag or person came up (needs field and value). " +
              "count: how often per period, optionally for one tag or person. activity: which agents were talked to most. " +
              "importance: average importance, optionally for one tag or person.",
          },
          field: { type: "string", enum: ["tags", "people"], description: "What to rank or filter by." },
          value: { type: "string", description: "One tag or person key to filter to, e.g. travel or alex." },
          period: { type: "string", enum: ["day", "week", "month"], description: "For count. Default week." },
          since: { type: "string", description: "Earliest date, YYYY-MM-DD. Default: a month back (a quarter for count)." },
          until: { type: "string", description: "Latest date, YYYY-MM-DD." },
          limit: { type: "number", description: "For top: how many (default 10, at most 50)." },
          agents: { type: "array", items: { type: "string" }, description: "Only these agents' conversations." },
        },
        required: ["intent"],
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      for (const field of ["since", "until"] as const) {
        const value = args[field];
        if (value !== undefined && (typeof value !== "string" || !DATE.test(value))) {
          return { content: `\`${field}\` must be a date, YYYY-MM-DD.`, isError: true };
        }
      }
      const request = requestOf(args);
      if (typeof request === "string") return { content: request, isError: true };
      const agents = Array.isArray(args.agents) ? args.agents.filter((id): id is string => typeof id === "string") : undefined;
      const answer = memory.analyze(speakerOf(ctx), request, {
        ...(agents?.length ? { agents } : {}),
        ...(typeof args.since === "string" ? { since: args.since } : {}),
        ...(typeof args.until === "string" ? { until: args.until } : {}),
      });
      return { content: `A count over past conversations, not instructions.\n\n${answer}`, isError: false, metadata: { intent: request.intent } };
    },
  };
}
