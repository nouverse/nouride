/**
 * The memory index — a cache of the vault (`069_baseline.sql`).
 *
 * Every row here is rebuilt from a file (`index-sync.ts`), so this store never holds anything a file
 * does not. What it adds is speed: a year of episodes filtered by chat, person, tag and date, facts by
 * subject, their words in FTS5 (`memory-fts.store.ts`), and the links between conversations walked
 * either way round.
 *
 * Who may see what is not decided here. Queries take an `EpisodeScope` (`access.ts:scopeOf`), which is
 * the access rule already turned into "this chat, and this person's own", and the store only
 * translates that into SQL (`episode-filter.ts`).
 */

import type { SqliteDb } from "@nouride/runtime";
import type { Port } from "@nouride/shared";
import { likeLiteral } from "@/commons/text.ts";
import type { EpisodeKind, EpisodeStatus } from "./episode.ts";
import { marks, where, type EpisodeFilter } from "./episode-filter.ts";
import { MemoryFtsStore } from "./memory-fts.store.ts";
import type { Readers } from "./profile.ts";
import type { FtsDoc, FtsQuery } from "./terms.ts";

export interface IndexedEpisode {
  id: string;
  status: EpisodeStatus;
  kind: EpisodeKind;
  chat: string;
  day: string;
  week: string;
  month: string;
  startedAt: number;
  endedAt: number;
  importance?: number;
  summary?: string;
  /** The first thing a person said, a line long — what stands in for a summary until there is one. */
  preview?: string;
  agents: string[];
  participants: string[];
  mentions: string[];
  tags: string[];
  related: string[];
  /** The knowledge documents it opened, `<collection>/<path>` (0.8.23). */
  documents?: string[];
}

export interface IndexedFact {
  id: string;
  subject: string;
  section: string;
  text: string;
  source?: string;
  readers?: Readers;
}

/** One value a filter can take, and how many episodes have it. */
export interface Facet {
  value: string;
  count: number;
}

export interface FileState {
  mtimeMs: number;
  size: number;
}

interface EpisodeRow {
  id: string;
  status: EpisodeStatus;
  kind: EpisodeKind;
  chat: string;
  day: string;
  week: string;
  month: string;
  started_at: number;
  ended_at: number;
  importance: number | null;
  summary: string | null;
  preview: string | null;
}

interface FactRow {
  id: string;
  subject: string;
  section: string;
  text: string;
  source: string | null;
  readers: string | null;
  readers_chat: string | null;
}

/** `,a,b,` — so `LIKE '%,sam,%'` never matches `rinaldi`. */
function delimited(values: readonly string[]): string {
  return `,${values.join(",")},`;
}

function undelimit(value: string): string[] {
  return value.split(",").filter(Boolean);
}

/** Pages a night's merge of the word index writes at most — 64 of FTS5's 4 KB pages. */
const MERGE_PAGES = 64;

/** Episodes a sweep over the vault reads at once (`pages`). */
const PAGE = 500;

export class MemoryIndexStore {
  private readonly fts: MemoryFtsStore;

  constructor(private readonly db: SqliteDb) {
    this.fts = new MemoryFtsStore(db);
  }

  // ─── files ───

  /**
   * Every file indexed under `prefix` (a path relative to the vault root), with the state it was indexed at —
   * read once per sync, not once per file.
   */
  indexedFiles(prefix: string): Map<string, FileState> {
    return new Map(
      this.db
        .prepare<{ path: string; mtime_ms: number; size: number }>("SELECT path, mtime_ms, size FROM memory_files WHERE path LIKE ? ESCAPE '\\'")
        .all(`${likeLiteral(prefix)}%`)
        .map((row) => [row.path, { mtimeMs: row.mtime_ms, size: row.size }]),
    );
  }

  /** The files under `prefix` as they now are, in place of those recorded — the stub folders, read whole. */
  private replaceFiles(prefix: string, files: ReadonlyMap<string, FileState>): void {
    this.db.prepare("DELETE FROM memory_files WHERE path LIKE ? ESCAPE '\\'").run(`${likeLiteral(prefix)}%`);
    for (const [path, state] of files) this.setFile(path, state);
  }

  private setFile(path: string, state: FileState): void {
    this.db
      .prepare("INSERT INTO memory_files (path, mtime_ms, size) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size")
      .run(path, state.mtimeMs, state.size);
  }

  forgetFile(path: string): void {
    this.db.prepare("DELETE FROM memory_files WHERE path = ?").run(path);
  }

  // ─── words ───

  /**
   * Items the words match, best first, and only what `filter` may see — episodes by scope, facts by id, and knowledge
   * sections by the collections named (0.8.20).
   */
  rank(match: FtsQuery, filter: EpisodeFilter, facts: readonly string[], limit: number, collections: readonly string[] = []): string[] {
    return this.fts.rank(match, where(filter), facts, limit, collections);
  }

  /** Every item the words match, unranked. */
  matching(match: FtsQuery): string[] {
    return this.fts.matching(match);
  }

  /**
   * After the nightly pass: merge the word index's segments — a bounded merge, or with `whole` every segment
   * into one — and refresh the planner's statistics.
   */
  optimizeText(whole: boolean): void {
    if (whole) this.fts.optimize();
    else this.fts.merge(MERGE_PAGES);
    this.db.optimize();
  }

  /** FTS5's own check of the word index — what `nouride doctor` reports. */
  checkText(): { ok: boolean; detail: string } {
    return this.fts.check();
  }

  // ─── episodes ───

  /** Replace one episode's rows with what its file now says. */
  putEpisode(episode: IndexedEpisode, doc: FtsDoc, file: { path: string; state: FileState }): void {
    this.db.transaction(() => {
      this.deleteEpisodeRows(episode.id);
      this.db
        .prepare(
          `INSERT INTO memory_episodes (id, status, kind, chat, day, week, month, started_at, ended_at, importance, summary, preview)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          episode.id, episode.status, episode.kind, episode.chat, episode.day, episode.week, episode.month,
          episode.startedAt, episode.endedAt, episode.importance ?? null, episode.summary ?? null, episode.preview ?? null,
        );
      const agent = this.db.prepare("INSERT INTO memory_episode_agents (episode_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
      for (const id of episode.agents) agent.run(episode.id, id);
      const person = this.db.prepare("INSERT INTO memory_episode_people (episode_id, person, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
      for (const who of episode.participants) person.run(episode.id, who, "participant");
      for (const who of episode.mentions) person.run(episode.id, who, "mention");
      const tag = this.db.prepare("INSERT INTO memory_episode_tags (episode_id, tag) VALUES (?, ?) ON CONFLICT DO NOTHING");
      for (const value of episode.tags) tag.run(episode.id, value);
      const related = this.db.prepare("INSERT INTO memory_episode_related (episode_id, related_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
      for (const id of episode.related) related.run(episode.id, id);
      const opened = this.db.prepare("INSERT INTO memory_episode_documents (episode_id, document) VALUES (?, ?) ON CONFLICT DO NOTHING");
      for (const document of episode.documents ?? []) opened.run(episode.id, document);
      this.fts.put(episode.id, doc);
      this.setFile(file.path, file.state);
    });
  }

  private deleteEpisodeRows(id: string): void {
    for (const table of ["memory_episode_agents", "memory_episode_people", "memory_episode_tags", "memory_episode_related", "memory_episode_documents"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE episode_id = ?`).run(id);
    }
    this.db.prepare("DELETE FROM memory_episodes WHERE id = ?").run(id);
    this.fts.drop([id]);
  }

  dropEpisode(id: string, path: string): void {
    this.db.transaction(() => {
      this.deleteEpisodeRows(id);
      this.forgetFile(path);
    });
  }

  private hydrate(rows: EpisodeRow[]): IndexedEpisode[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const group = <T extends { episode_id: string }>(sql: string): Map<string, T[]> => {
      const out = new Map<string, T[]>();
      for (const row of this.db.prepare<T>(sql.replace("(?)", `(${marks(ids)})`)).all(...ids)) {
        out.set(row.episode_id, [...(out.get(row.episode_id) ?? []), row]);
      }
      return out;
    };
    const agents = group<{ episode_id: string; agent_id: string }>("SELECT episode_id, agent_id FROM memory_episode_agents WHERE episode_id IN (?) ORDER BY agent_id");
    const people = group<{ episode_id: string; person: string; role: string }>("SELECT episode_id, person, role FROM memory_episode_people WHERE episode_id IN (?) ORDER BY person");
    const tags = group<{ episode_id: string; tag: string }>("SELECT episode_id, tag FROM memory_episode_tags WHERE episode_id IN (?) ORDER BY tag");
    const related = group<{ episode_id: string; related_id: string }>("SELECT episode_id, related_id FROM memory_episode_related WHERE episode_id IN (?) ORDER BY related_id");
    const documents = group<{ episode_id: string; document: string }>("SELECT episode_id, document FROM memory_episode_documents WHERE episode_id IN (?) ORDER BY document");
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      kind: row.kind,
      chat: row.chat,
      day: row.day,
      week: row.week,
      month: row.month,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      ...(row.importance !== null ? { importance: row.importance } : {}),
      ...(row.summary !== null ? { summary: row.summary } : {}),
      ...(row.preview !== null ? { preview: row.preview } : {}),
      agents: (agents.get(row.id) ?? []).map((r) => r.agent_id),
      participants: (people.get(row.id) ?? []).filter((r) => r.role === "participant").map((r) => r.person),
      mentions: (people.get(row.id) ?? []).filter((r) => r.role === "mention").map((r) => r.person),
      tags: (tags.get(row.id) ?? []).map((r) => r.tag),
      related: (related.get(row.id) ?? []).map((r) => r.related_id),
      ...(documents.has(row.id) ? { documents: documents.get(row.id)!.map((r) => r.document) } : {}),
    }));
  }

  /** Episodes in scope, newest first. */
  episodes(filter: EpisodeFilter, limit: number): IndexedEpisode[] {
    const { sql, params } = where(filter);
    const rows = this.db.prepare<EpisodeRow>(`SELECT e.* FROM memory_episodes e WHERE ${sql} ORDER BY e.started_at DESC LIMIT ?`).all(...params, limit);
    return this.hydrate(rows);
  }

  /**
   * The ids of the episodes in scope, newest first, and nothing else — what search ranks by meaning. It read the
   * same episodes whole, five statements over up to 5,000 ids, only to collect their ids.
   */
  episodeIds(filter: EpisodeFilter, limit: number): string[] {
    const { sql, params } = where(filter);
    return this.db.prepare<{ id: string }>(`SELECT e.id FROM memory_episodes e WHERE ${sql} ORDER BY e.started_at DESC LIMIT ?`).all(...params, limit).map((row) => row.id);
  }

  /** Episodes by id, whoever may see them — for the operator and for the nightly pass, never for a chat. */
  episodesById(ids: readonly string[]): IndexedEpisode[] {
    if (ids.length === 0) return [];
    return this.hydrate(this.db.prepare<EpisodeRow>(`SELECT * FROM memory_episodes WHERE id IN (${marks(ids)}) ORDER BY started_at`).all(...ids));
  }

  /** Every episode with this status, oldest first — the nightly pass's queue, compaction's candidates. */
  withStatus(status: EpisodeStatus): IndexedEpisode[] {
    return this.hydrate(this.db.prepare<EpisodeRow>("SELECT * FROM memory_episodes WHERE status = ? ORDER BY started_at").all(status));
  }

  /** Every episode, newest first, filtered only by what the operator asked for. */
  allEpisodes(filter: Omit<EpisodeFilter, "scope">, limit: number): IndexedEpisode[] {
    const { sql, params } = where(filter);
    return this.hydrate(this.db.prepare<EpisodeRow>(`SELECT e.* FROM memory_episodes e WHERE ${sql} ORDER BY e.started_at DESC LIMIT ?`).all(...params, limit));
  }

  /**
   * Every episode a filter matches, newest first, a page at a time — what a sweep over the whole vault reads: a catch-up
   * of vectors, a forget, a tag tidy's plan. Each asked for a million at once, so each held every episode of a large
   * vault whole, its ids bound into one statement, before it looked at the first.
   */
  *pages(filter: Omit<EpisodeFilter, "scope">, size: number = PAGE): Generator<IndexedEpisode[]> {
    const { sql, params } = where(filter);
    let last: EpisodeRow | undefined;
    for (;;) {
      // Past the last row read, by the order read in — a row written or removed meanwhile neither repeats nor skips one.
      const rows = last
        ? this.db
            .prepare<EpisodeRow>(`SELECT e.* FROM memory_episodes e WHERE ${sql} AND (e.started_at < ? OR (e.started_at = ? AND e.id < ?)) ORDER BY e.started_at DESC, e.id DESC LIMIT ?`)
            .all(...params, last.started_at, last.started_at, last.id, size)
        : this.db.prepare<EpisodeRow>(`SELECT e.* FROM memory_episodes e WHERE ${sql} ORDER BY e.started_at DESC, e.id DESC LIMIT ?`).all(...params, size);
      if (rows.length) yield this.hydrate(rows);
      if (rows.length < size) return;
      last = rows.at(-1);
    }
  }

  /** How many episodes a filter matches, whatever the limit — the graph says when it shows fewer. */
  countEpisodes(filter: Omit<EpisodeFilter, "scope">): number {
    const { sql, params } = where(filter);
    return this.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_episodes e WHERE ${sql}`).get(...params)?.n ?? 0;
  }

  /**
   * Every agent, person and tag any episode links to, with how many episodes do — what a filter can
   * be set to. Three grouped reads of the link tables, each on its own index.
   */
  facets(): { agents: Facet[]; people: Facet[]; tags: Facet[] } {
    const count = (sql: string) => this.db.prepare<Facet>(sql).all();
    return {
      agents: count("SELECT agent_id AS value, COUNT(*) AS count FROM memory_episode_agents GROUP BY agent_id ORDER BY count DESC, value"),
      people: count("SELECT person AS value, COUNT(DISTINCT episode_id) AS count FROM memory_episode_people GROUP BY person ORDER BY count DESC, value"),
      tags: count("SELECT tag AS value, COUNT(*) AS count FROM memory_episode_tags GROUP BY tag ORDER BY count DESC, value"),
    };
  }

  /**
   * What changes whenever any indexed file does: added, edited or dropped. A cache key for what is
   * derived from the whole index, read from `memory_files` alone — a few hundred rows, no join.
   */
  revision(): string {
    const row = this.db.prepare<{ n: number; latest: number | null; bytes: number | null }>("SELECT COUNT(*) AS n, MAX(mtime_ms) AS latest, SUM(size) AS bytes FROM memory_files").get();
    return `${row?.n ?? 0}:${row?.latest ?? 0}:${row?.bytes ?? 0}`;
  }

  /** Episodes that share a person and a tag with this one, in a window — `related`'s candidates. */
  neighbours(input: { id: string; people: readonly string[]; tags: readonly string[]; since: number }, limit: number): { id: string; shared: number }[] {
    if (input.people.length === 0 || input.tags.length === 0) return [];
    return this.db
      .prepare<{ id: string; shared: number }>(
        `SELECT t.episode_id AS id, COUNT(*) AS shared FROM memory_episode_tags t
         JOIN memory_episodes e ON e.id = t.episode_id
         WHERE t.tag IN (${marks(input.tags)}) AND e.id <> ? AND e.started_at >= ?
           AND EXISTS (SELECT 1 FROM memory_episode_people p WHERE p.episode_id = e.id AND p.person IN (${marks(input.people)}))
         GROUP BY t.episode_id ORDER BY shared DESC, MAX(e.started_at) DESC LIMIT ?`,
      )
      .all(...input.tags, input.id, input.since, ...input.people, limit);
  }

  /**
   * Episodes linked to these either way round, within `depth` links, each with how far — `search.ts`'s
   * hop. `related` is written on the episode being summarised only, so most links are stored one way;
   * walking both is what brings the conversation that *continued* a hit. `UNION` and the depth bound
   * stop a cycle.
   */
  reachable(ids: readonly string[], depth: number): { origin: string; id: string; depth: number }[] {
    if (ids.length === 0 || depth <= 0) return [];
    return this.db
      .prepare<{ origin: string; id: string; depth: number }>(
        `WITH RECURSIVE walk(origin, id, depth) AS (
           SELECT value, value, 0 FROM json_each(?1)
           UNION
           SELECT walk.origin, r.related_id, walk.depth + 1 FROM walk JOIN memory_episode_related r ON r.episode_id = walk.id WHERE walk.depth < ?2
           UNION
           SELECT walk.origin, r.episode_id, walk.depth + 1 FROM walk JOIN memory_episode_related r ON r.related_id = walk.id WHERE walk.depth < ?2
         )
         SELECT origin, id, MIN(depth) AS depth FROM walk WHERE id <> origin GROUP BY origin, id`,
      )
      .all(JSON.stringify(ids), depth);
  }

  /** When this chat's latest episode ended: where the vault says it was last cut (`run.ts:cutChat`). */
  lastEndedAt(chat: string): number | null {
    return this.db.prepare<{ at: number | null }>("SELECT MAX(ended_at) AS at FROM memory_episodes WHERE chat = ?").get(chat)?.at ?? null;
  }

  /** The nearest days before and after this one that have an episode — a day hub's neighbours. */
  adjacentDays(day: string): { previous?: string; next?: string } {
    const previous = this.db.prepare<{ day: string | null }>("SELECT MAX(day) AS day FROM memory_episodes WHERE day < ?").get(day)?.day;
    const next = this.db.prepare<{ day: string | null }>("SELECT MIN(day) AS day FROM memory_episodes WHERE day > ?").get(day)?.day;
    return { ...(previous ? { previous } : {}), ...(next ? { next } : {}) };
  }

  // ─── facts ───

  /** Replace one subject's facts with what its file now says. */
  putFacts(subject: string, facts: readonly (IndexedFact & { doc: FtsDoc })[], file: { path: string; state: FileState }): void {
    this.db.transaction(() => {
      this.deleteFacts(subject);
      const insert = this.db.prepare(
        "INSERT INTO memory_facts (id, subject, position, section, text, source, readers, readers_chat) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      );
      for (const [position, fact] of facts.entries()) {
        insert.run(fact.id, subject, position, fact.section, fact.text, fact.source ?? null, fact.readers ? delimited(fact.readers.people) : null, fact.readers?.chat ?? null);
        this.fts.put(fact.id, fact.doc);
      }
      this.setFile(file.path, file.state);
    });
  }

  private deleteFacts(subject: string): void {
    this.fts.drop(this.db.prepare<{ id: string }>("SELECT id FROM memory_facts WHERE subject = ?").all(subject).map((row) => row.id));
    this.db.prepare("DELETE FROM memory_facts WHERE subject = ?").run(subject);
  }

  dropFacts(subject: string, path: string): void {
    this.db.transaction(() => {
      this.deleteFacts(subject);
      this.forgetFile(path);
    });
  }

  facts(subjects: readonly string[]): IndexedFact[] {
    if (subjects.length === 0) return [];
    return this.db
      .prepare<FactRow>(`SELECT * FROM memory_facts WHERE subject IN (${marks(subjects)}) ORDER BY subject, position`)
      .all(...subjects)
      .map((row) => ({
        id: row.id,
        subject: row.subject,
        section: row.section,
        text: row.text,
        ...(row.source ? { source: row.source } : {}),
        ...(row.readers !== null ? { readers: { people: undelimit(row.readers), ...(row.readers_chat ? { chat: row.readers_chat } : {}) } } : {}),
      }));
  }

  subjects(): string[] {
    return this.db.prepare<{ subject: string }>("SELECT DISTINCT subject FROM memory_facts ORDER BY subject").all().map((row) => row.subject);
  }

  // ─── tags and groups ───

  /** Every alias, from the tag stubs `files` names as read — recorded, so an unchanged folder is not read again. */
  replaceAliases(aliases: ReadonlyMap<string, string>, files: ReadonlyMap<string, FileState>): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_tag_aliases").run();
      const insert = this.db.prepare("INSERT INTO memory_tag_aliases (alias, tag) VALUES (?, ?) ON CONFLICT DO NOTHING");
      for (const [alias, tag] of aliases) insert.run(alias, tag);
      this.replaceFiles("tags/", files);
    });
  }

  aliases(): Map<string, string> {
    return new Map(this.db.prepare<{ alias: string; tag: string }>("SELECT alias, tag FROM memory_tag_aliases").all().map((row) => [row.alias, row.tag]));
  }

  /** Which chat each group stub names, from the stubs `files` names as read — recorded like the tags'. */
  replaceGroups(groups: ReadonlyMap<string, string>, files: ReadonlyMap<string, FileState>): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_groups").run();
      const insert = this.db.prepare("INSERT INTO memory_groups (chat, slug) VALUES (?, ?) ON CONFLICT DO NOTHING");
      for (const [chat, slug] of groups) insert.run(chat, slug);
      this.replaceFiles("groups/", files);
    });
  }

  /** Record the stub just written for a chat, so the next cut of it finds the same group. */
  putGroup(chat: string, slug: string): void {
    this.db.prepare("INSERT INTO memory_groups (chat, slug) VALUES (?, ?) ON CONFLICT (chat) DO UPDATE SET slug = excluded.slug").run(chat, slug);
  }

  /** The documents these episodes opened, as (episode, document) pairs: the graph's lines between them (0.8.23). */
  documentsOpened(ids: readonly string[]): [string, string][] {
    if (ids.length === 0) return [];
    return this.db
      .prepare<{ episode_id: string; document: string }>(`SELECT episode_id, document FROM memory_episode_documents WHERE episode_id IN (${marks(ids)})`)
      .all(...ids)
      .map((row) => [row.episode_id, row.document]);
  }

  groups(): Map<string, string> {
    return new Map(this.db.prepare<{ chat: string; slug: string }>("SELECT chat, slug FROM memory_groups").all().map((row) => [row.chat, row.slug]));
  }

  /** Empty the cache — `nouride memory reindex` rebuilds it from the files. */
  clear(): void {
    this.db.transaction(() => {
      for (const table of [
        "memory_episode_agents", "memory_episode_people", "memory_episode_tags", "memory_episode_related", "memory_episode_documents", "memory_episodes",
        "memory_facts", "memory_tag_aliases", "memory_groups", "memory_files",
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.fts.clear();
    });
  }
}

export type MemoryIndexPort = Port<MemoryIndexStore>;
