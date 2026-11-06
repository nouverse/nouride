/**
 * Counts over episodes — what `memory_analyze` answers, and the tags the nightly pass is asked to
 * reuse (`069_baseline.sql`).
 *
 * Its own store beside the index because it reads the same tables for a different question: the
 * index is a cache kept true to the files, this is aggregation over it. The scope clause is the
 * index's own (`where`), so a count and a search can never disagree about what an audience may see.
 */

import type { SqliteDb } from "@nouride/runtime";
import type { Port } from "@nouride/shared";
import { where, type EpisodeFilter } from "./episode-filter.ts";

export type Period = "day" | "week" | "month";

export class MemoryAnalyticsStore {
  constructor(private readonly db: SqliteDb) {}

  /**
   * Every tag in scope with how many episodes carry it and when it was last used — what the nightly
   * pass shows a model as the vocabulary to reuse. One grouped read per audience per night.
   */
  tagUse(filter: EpisodeFilter): { tag: string; n: number; last: number }[] {
    const { sql, params } = where(filter);
    return this.db
      .prepare<{ tag: string; n: number; last: number }>(
        `SELECT t.tag AS tag, COUNT(*) AS n, MAX(e.started_at) AS last FROM memory_episode_tags t JOIN memory_episodes e ON e.id = t.episode_id
         WHERE ${sql} GROUP BY t.tag`,
      )
      .all(...params);
  }

  /** How many conversations in scope carry a tag at all — how young an audience's vocabulary still is. */
  taggedIn(filter: EpisodeFilter): number {
    const { sql, params } = where(filter);
    return (
      this.db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_episodes e WHERE ${sql} AND EXISTS (SELECT 1 FROM memory_episode_tags t WHERE t.episode_id = e.id)`)
        .get(...params)?.n ?? 0
    );
  }

  /** The tags one chat used since a moment, most used first — so a conversation that continues keeps its tags. */
  chatTags(chat: string, since: number, limit: number): string[] {
    return this.db
      .prepare<{ tag: string }>(
        `SELECT t.tag AS tag FROM memory_episodes e JOIN memory_episode_tags t ON t.episode_id = e.id
         WHERE e.chat = ? AND e.started_at >= ? GROUP BY t.tag ORDER BY COUNT(*) DESC, t.tag LIMIT ?`,
      )
      .all(chat, since, limit)
      .map((row) => row.tag);
  }

  /** Every tag in the vault with the episodes it is on, and how many episodes carry a tag at all — what the gate folds against. */
  tagCounts(): { counts: Map<string, number>; tagged: number } {
    const counts = new Map(this.db.prepare<{ tag: string; n: number }>("SELECT tag, COUNT(*) AS n FROM memory_episode_tags GROUP BY tag").all().map((row) => [row.tag, row.n]));
    const tagged = this.db.prepare<{ n: number }>("SELECT COUNT(DISTINCT episode_id) AS n FROM memory_episode_tags").get()?.n ?? 0;
    return { counts, tagged };
  }

  /** The tags most used in scope, most used first. */
  topTags(filter: EpisodeFilter, limit: number): { value: string; n: number }[] {
    const { sql, params } = where(filter);
    return this.db
      .prepare<{ value: string; n: number }>(
        `SELECT t.tag AS value, COUNT(*) AS n FROM memory_episode_tags t JOIN memory_episodes e ON e.id = t.episode_id
         WHERE ${sql} GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT ?`,
      )
      .all(...params, limit);
  }

  topPeople(filter: EpisodeFilter, limit: number): { value: string; n: number }[] {
    const { sql, params } = where(filter);
    return this.db
      .prepare<{ value: string; n: number }>(
        `SELECT p.person AS value, COUNT(DISTINCT p.episode_id) AS n FROM memory_episode_people p JOIN memory_episodes e ON e.id = p.episode_id
         WHERE ${sql} GROUP BY p.person ORDER BY n DESC, p.person LIMIT ?`,
      )
      .all(...params, limit);
  }

  countBy(filter: EpisodeFilter, period: Period): { bucket: string; n: number }[] {
    const { sql, params } = where(filter);
    const column = { day: "e.day", week: "e.week", month: "e.month" }[period];
    return this.db
      .prepare<{ bucket: string; n: number }>(`SELECT ${column} AS bucket, COUNT(*) AS n FROM memory_episodes e WHERE ${sql} GROUP BY ${column} ORDER BY ${column}`)
      .all(...params);
  }

  byAgent(filter: EpisodeFilter): { value: string; n: number }[] {
    const { sql, params } = where(filter);
    return this.db
      .prepare<{ value: string; n: number }>(
        `SELECT a.agent_id AS value, COUNT(*) AS n FROM memory_episode_agents a JOIN memory_episodes e ON e.id = a.episode_id
         WHERE ${sql} GROUP BY a.agent_id ORDER BY n DESC, a.agent_id`,
      )
      .all(...params);
  }

  /**
   * Conversations begun since `since`, by the agent the nightly pass counts each under — the first by id, which is what
   * `agents[0]` of an episode read whole is — and when the first conversation of all began. Archive episodes are left
   * out: an import before 0.8.0 made them, nobody had them this week. The pace `backlog.ts` holds the pass to.
   */
  begunSince(since: number): { byAgent: Map<string, number>; first: number | null } {
    const byAgent = new Map(
      this.db
        .prepare<{ agent: string; n: number }>(
          `SELECT agent, COUNT(*) AS n FROM (
             SELECT COALESCE(MIN(a.agent_id), '') AS agent FROM memory_episodes e LEFT JOIN memory_episode_agents a ON a.episode_id = e.id
             WHERE e.started_at >= ? AND e.kind <> 'archive' GROUP BY e.id
           ) GROUP BY agent`,
        )
        .all(since)
        .map((row) => [row.agent, row.n]),
    );
    const first = this.db.prepare<{ at: number }>("SELECT started_at AS at FROM memory_episodes WHERE kind <> 'archive' ORDER BY started_at LIMIT 1").get()?.at ?? null;
    return { byAgent, first };
  }

  importance(filter: EpisodeFilter): { average: number | null; n: number; high: number } {
    const { sql, params } = where(filter);
    const row = this.db
      .prepare<{ average: number | null; n: number; high: number | null }>(
        `SELECT AVG(e.importance) AS average, COUNT(e.importance) AS n, SUM(CASE WHEN e.importance >= 4 THEN 1 ELSE 0 END) AS high
         FROM memory_episodes e WHERE ${sql}`,
      )
      .get(...params);
    return { average: row?.average ?? null, n: row?.n ?? 0, high: row?.high ?? 0 };
  }
}

export type MemoryAnalyticsPort = Port<MemoryAnalyticsStore>;
