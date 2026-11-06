/**
 * Which episodes a question is about, as SQL — the one `WHERE` the index and the analytics both read through, so a
 * count and a search agree on what a chat may see.
 *
 * Who may see what is not decided here. A filter's `scope` (`access.ts:scopeOf`) is the access rule already turned into
 * "this chat, and this person's own", and this only translates it. Pure.
 */

import type { EpisodeScope } from "./access.ts";
import type { EpisodeStatus } from "./episode.ts";

export interface EpisodeFilter {
  scope: EpisodeScope;
  /** Only episodes one of these agents took part in — an MCP token's bound. */
  agents?: readonly string[];
  /** Inclusive days, `YYYY-MM-DD`. */
  since?: string;
  until?: string;
  /** Any of these people, taking part or talked about. */
  people?: readonly string[];
  tags?: readonly string[];
  ids?: readonly string[];
  statuses?: readonly EpisodeStatus[];
}

/** `?, ?, …`, one for each value — bound, never written into the SQL. */
export function marks(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

/** The WHERE clause for a filter. No scope is the operator's view — every episode — and only a caller outside any chat passes none. */
export function where(filter: Omit<EpisodeFilter, "scope"> & { scope?: EpisodeScope }): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.scope?.participant) {
    clauses.push(
      `(e.chat = ? OR EXISTS (SELECT 1 FROM memory_episode_people p WHERE p.episode_id = e.id AND p.role = 'participant' AND p.person = ?))`,
    );
    params.push(filter.scope.chat, filter.scope.participant);
  } else if (filter.scope) {
    clauses.push("e.chat = ?");
    params.push(filter.scope.chat);
  }
  if (filter.agents?.length) {
    clauses.push(`EXISTS (SELECT 1 FROM memory_episode_agents a WHERE a.episode_id = e.id AND a.agent_id IN (${marks(filter.agents)}))`);
    params.push(...filter.agents);
  }
  if (filter.since) {
    clauses.push("e.day >= ?");
    params.push(filter.since);
  }
  if (filter.until) {
    clauses.push("e.day <= ?");
    params.push(filter.until);
  }
  if (filter.people?.length) {
    clauses.push(`EXISTS (SELECT 1 FROM memory_episode_people q WHERE q.episode_id = e.id AND q.person IN (${marks(filter.people)}))`);
    params.push(...filter.people);
  }
  if (filter.tags?.length) {
    clauses.push(`EXISTS (SELECT 1 FROM memory_episode_tags t WHERE t.episode_id = e.id AND t.tag IN (${marks(filter.tags)}))`);
    params.push(...filter.tags);
  }
  if (filter.ids) {
    clauses.push(filter.ids.length ? `e.id IN (${marks(filter.ids)})` : "1 = 0");
    params.push(...filter.ids);
  }
  if (filter.statuses?.length) {
    clauses.push(`e.status IN (${marks(filter.statuses)})`);
    params.push(...filter.statuses);
  }
  return { sql: clauses.length ? clauses.join(" AND ") : "1 = 1", params };
}
