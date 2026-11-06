/**
 * The graph's filter as it sits in the URL: who, what, how far back, and how many conversations.
 * Anything unrecognised is dropped rather than refused, so a link with a key this build does not know
 * still opens.
 */

import type { GraphFilter } from "@/commons/lib/api.memory";

export type GraphRange = "30d" | "90d" | "1y" | "all";

/** Several of one kind match any of them; different kinds must all match. */
export interface GraphSearch {
  agents?: string[];
  people?: string[];
  tags?: string[];
  range?: GraphRange;
  limit?: number;
  /** The knowledge base's documents laid over the conversations: off unless asked for (0.8.20). */
  knowledge?: boolean;
}

export const RANGES: { value: GraphRange; label: string; days?: number }[] = [
  { value: "30d", label: "30 days", days: 30 },
  { value: "90d", label: "90 days", days: 90 },
  { value: "1y", label: "A year", days: 365 },
  { value: "all", label: "All time" },
];

/** Enough to see a shape, up to what a laptop lays out smoothly. The daemon caps it again. */
export const LIMITS = [150, 300, 600, 1000] as const;
export const DEFAULT_LIMIT = 300;
export const DEFAULT_RANGE: GraphRange = "all";

/** A list of non-blank strings, without repeats; empty is absent. */
function list(value: unknown): string[] | undefined {
  const out = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item === "string" && item.trim()) out.add(item.trim());
  }
  return out.size ? [...out] : undefined;
}

export function parseGraphSearch(search: Record<string, unknown>): GraphSearch {
  const range = RANGES.find((option) => option.value === search.range)?.value;
  const limit = LIMITS.find((option) => option === Number(search.limit));
  const agents = list(search.agents);
  const people = list(search.people);
  const tags = list(search.tags);
  const knowledge = search.knowledge === true || search.knowledge === "true" || search.knowledge === "1";
  return {
    ...(agents ? { agents } : {}),
    ...(people ? { people } : {}),
    ...(tags ? { tags } : {}),
    ...(range && range !== DEFAULT_RANGE ? { range } : {}),
    ...(limit && limit !== DEFAULT_LIMIT ? { limit } : {}),
    ...(knowledge ? { knowledge } : {}),
  };
}

function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function toFilter(search: GraphSearch): GraphFilter {
  const days = RANGES.find((option) => option.value === (search.range ?? DEFAULT_RANGE))?.days;
  return {
    ...(search.agents?.length ? { agents: [...search.agents].sort() } : {}),
    ...(search.people?.length ? { people: [...search.people].sort() } : {}),
    ...(search.tags?.length ? { tags: [...search.tags].sort() } : {}),
    ...(days ? { since: daysAgo(days) } : {}),
    limit: search.limit ?? DEFAULT_LIMIT,
    ...(search.knowledge ? { knowledge: true } : {}),
  };
}
