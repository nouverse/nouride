/**
 * Conversation persistence — §6.4, §14 SPEC.
 *
 * A conversation is a `sessions` row, keyed by (agent, chat, gateway), and its messages, one
 * `session_messages` row each (`069_baseline.sql`). The reason it is persisted at all: a restart
 * mid-conversation should not amnesia the agent.
 *
 * It was one JSON column, on the argument that a conversation is always read and written whole. Read
 * whole, yes; but writing it whole meant every turn rewrote the entire history — a 300 KB conversation
 * is some seventy pages through the WAL and again at the checkpoint, for the few kilobytes a turn adds
 * (E2). Callers still hand `save` the whole conversation; the store keeps every row that is unchanged
 * and writes the rest (`planKeep`).
 */

import {
  createLogger,
  sessionIdFor,
  type ChatMessage,
  type Session,
  type SessionKey,
  type SessionType,
  type Port,
} from "@nouride/shared";
import { sha256Text, type SqliteDb } from "@nouride/runtime";

const log = createLogger("sessions");

interface SessionRow {
  id: string;
  agent_id: string;
  chat_id: string;
  gateway: string;
  context_token_count: number;
  session_type: string;
  status: string;
  created_at: number;
  started_at: number;
  updated_at: number;
}

export interface LoadedSession extends Session {
  messages: ChatMessage[];
}

/** A conversation's `/model` and `/effort` as its row keeps them (076): null is none, the agent's own. */
export interface StoredChoices {
  model: string | null;
  effort: string | null;
}

/** How to page and narrow the conversation list. Every field is optional; none of them is a default. */
export interface SessionListOptions {
  /** At most this many, newest first. Capped at 500 — this is a list somebody scrolls. */
  limit?: number;
  /** Only conversations last touched before this moment. The "load more" cursor. */
  before?: number;
  agentId?: string;
  /** Matched against the conversation's opening question and its chat id. */
  query?: string;
  /** Leave out one connection's conversations — the missions' own, which are not a person's chats. */
  notGateway?: string;
}

export class SessionStore {
  constructor(private readonly db: SqliteDb) {}

  /** Existing session, or a fresh empty one that is not written until it has content. */
  load(key: SessionKey, type: SessionType = "main"): LoadedSession {
    const id = sessionIdFor(key);
    const row = this.db
      .prepare<SessionRow>("SELECT * FROM sessions WHERE id = ?")
      .get(id);

    if (!row) {
      const now = Date.now();
      return {
        id,
        agentId: key.agentId,
        chatId: key.chatId,
        gatewayId: key.gatewayId,
        sessionType: type,
        status: "active",
        contextTokenCount: 0,
        createdAt: now,
        startedAt: now,
        updatedAt: now,
        messages: [],
      };
    }

    return { ...toSession(row), messages: this.messagesOf(id) };
  }

  save(key: SessionKey, messages: ChatMessage[], tokenCount: number): void {
    this.write(key, messages, tokenCount, false);
  }

  /**
   * `/new` — drop the history, keep the row so created_at survives.
   *
   * `started_at` does *not* survive: it dates the conversation, not the chat. `created_at` is the wrong
   * column for "did this conversation start before today's boundary" — the rollover would fire, clear
   * the history, and still see the old day, so every message after it would roll over again, each
   * capturing an empty conversation.
   */
  clear(key: SessionKey): void {
    this.write(key, [], 0, true);
  }

  /**
   * This conversation's `/model` and `/effort` (076). On its row rather than in memory: the daemon restarts at every
   * update, and each restart dropped them. What a stored value means, and one no longer usable, is `ModelOverrides`'.
   */
  choices(id: string): StoredChoices {
    const row = this.db
      .prepare<{ model_override: string | null; effort_override: string | null }>("SELECT model_override, effort_override FROM sessions WHERE id = ?")
      .get(id);
    return { model: row?.model_override ?? null, effort: row?.effort_override ?? null };
  }

  /**
   * Keep `/model`'s choice on the conversation's row. Made before its first message, it writes the row then, since the
   * row is where it is kept: not started (0), so a room's look-back and a daily rollover still count from that message.
   */
  keepModel(key: SessionKey, model: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_id, chat_id, gateway, created_at, started_at, updated_at, model_override)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET model_override = excluded.model_override`,
      )
      .run(sessionIdFor(key), key.agentId, key.chatId, key.gatewayId, now, now, model);
  }

  /** And `/effort`'s, the same way. */
  keepEffort(key: SessionKey, effort: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_id, chat_id, gateway, created_at, started_at, updated_at, effort_override)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET effort_override = excluded.effort_override`,
      )
      .run(sessionIdFor(key), key.agentId, key.chatId, key.gatewayId, now, now, effort);
  }

  /** Drop `/model`'s choice: `/model default`, and the endings that drop it (`pipeline/conversation-end.ts`). */
  dropModel(id: string): void {
    this.db.prepare("UPDATE sessions SET model_override = NULL WHERE id = ?").run(id);
  }

  /** And `/effort`'s: `/effort default`, a lock, and the same endings. */
  dropEffort(id: string): void {
    this.db.prepare("UPDATE sessions SET effort_override = NULL WHERE id = ?").run(id);
  }

  /**
   * The conversation row's counters, and the messages that changed — in one transaction, or a savepoint
   * inside the turn's settle (`pipeline/turn.ts`), which commits it with the journal and the record.
   *
   * Which rows stay is decided on their hashes alone, read without their messages (the column comes
   * before `message` in the row, so SQLite stops short of its overflow pages).
   */
  private write(
    key: SessionKey,
    messages: ChatMessage[],
    tokenCount: number,
    restart: boolean,
  ): void {
    const id = sessionIdFor(key);
    const now = Date.now();
    /**
     * A new conversation started when its first message came, not when its first turn was written at the end: written
     * then, the usage that turn recorded was older than the conversation, and `/status` — which counts usage since it
     * started — said a coding CLI's tokens were "none reported" after its first answer (0.8.13, found live). A row a
     * choice wrote before any message has not started (`keepModel`), and takes its start from this save.
     */
    const started = Math.min(now, ...messages.flatMap((message) => (typeof message.timestamp === "number" ? [message.timestamp] : [])));
    const texts = messages.map((message) => JSON.stringify(message));
    const hashes = texts.map(messageHash);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, agent_id, chat_id, gateway, context_token_count,
                                 session_type, status, created_at, started_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'main', 'active', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             context_token_count = excluded.context_token_count,
             started_at = CASE WHEN ? OR sessions.started_at = 0 THEN excluded.started_at ELSE sessions.started_at END,
             updated_at = excluded.updated_at`,
        )
        .run(id, key.agentId, key.chatId, key.gatewayId, tokenCount, now, started, now, restart ? 1 : 0);

      const stored = this.db
        .prepare<{ seq: number; hash: string | null }>("SELECT seq, hash FROM session_messages WHERE session_id = ? ORDER BY seq")
        .all(id);
      const { from, kept } = planKeep(
        stored.map((row) => row.hash),
        hashes,
      );
      if (kept === 0) {
        if (stored.length > 0) this.db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(id);
      } else {
        const first = stored[from]!.seq;
        const last = stored[from + kept - 1]!.seq;
        if (from > 0) this.db.prepare("DELETE FROM session_messages WHERE session_id = ? AND seq < ?").run(id, first);
        if (from + kept < stored.length) this.db.prepare("DELETE FROM session_messages WHERE session_id = ? AND seq > ?").run(id, last);
      }
      const next = kept === 0 ? 0 : stored[from + kept - 1]!.seq + 1;
      const insert = this.db.prepare("INSERT INTO session_messages (session_id, seq, hash, message) VALUES (?, ?, ?, ?)");
      for (let i = kept; i < texts.length; i += 1) insert.run(id, next + i - kept, hashes[i]!, texts[i]!);
    });
  }

  /**
   * A conversation's messages, in order.
   *
   * One that cannot be read starts the conversation fresh instead of throwing, as a corrupt `context`
   * column did. Skipping only that message is not an option: a tool result whose call is gone, or a call
   * whose result is, is a request Anthropic refuses outright — the whole history would fail where an empty
   * one answers. The next save replaces the rows, the unreadable one with them.
   */
  private messagesOf(id: string): ChatMessage[] {
    const rows = this.db
      .prepare<{ message: string }>("SELECT message FROM session_messages WHERE session_id = ? ORDER BY seq")
      .all(id);
    const messages: ChatMessage[] = [];
    for (const row of rows) {
      const message = parseMessage(row.message);
      if (!message) {
        log.error("a message of this conversation is unreadable: starting fresh", { session: id, messages: rows.length });
        return [];
      }
      messages.push(message);
    }
    return messages;
  }

  /**
   * Every conversation, newest first — a page at a time, and searchable.
   *
   * This was `LIMIT 100` with no way to ask for the next hundred, which made the dashboard's history
   * a list that silently stopped. The reasoning at the time was that "an operator who needs the
   * thousandth-oldest conversation is looking for something a list cannot help them find anyway", and
   * that is true of a *list*. It is the argument for search, not for a cap: the answer to a long
   * history is to be able to page through it and to search it, not to pretend the older half is not
   * there.
   *
   * `before` is a cursor on `updated_at` rather than an offset, so a conversation that moves to the
   * top while somebody is scrolling does not push a row they have already seen onto the next page.
   */
  list(options: SessionListOptions = {}): Session[] {
    const { where, params } = this.filter(options);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    return this.db
      .prepare<SessionRow>(
        `SELECT s.* FROM sessions s ${where} ORDER BY s.updated_at DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map(toSession);
  }

  /** How many there are in total — the number the history badge should be showing. */
  count(options: Omit<SessionListOptions, "limit" | "before"> = {}): number {
    const { where, params } = this.filter(options);
    const row = this.db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions s ${where}`)
      .get(...params);
    return row?.n ?? 0;
  }

  /**
   * The shared WHERE clause, and why the search reaches into `turn_records`.
   *
   * What the dashboard shows as a conversation's name is the first thing that was asked in it, which
   * lives in the turn records rather than here — so a search that only looked at this table could
   * match nothing a reader can see on screen. The alternative was to fetch every title and filter in
   * the route, which is the same join done worse: unindexed, in application memory, and paged after
   * the fact. Same database, one statement.
   */
  private filter(options: SessionListOptions): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.agentId) {
      clauses.push("s.agent_id = ?");
      params.push(options.agentId);
    }
    if (options.notGateway) {
      clauses.push("s.gateway <> ?");
      params.push(options.notGateway);
    }
    if (options.before !== undefined) {
      clauses.push("s.updated_at < ?");
      params.push(options.before);
    }
    const query = options.query?.trim();
    if (query) {
      // Escaped, because `%` and `_` are wildcards and an operator searching for `100%` means it
      // literally. LIKE is case-insensitive for ASCII in SQLite, which is the whole requirement.
      const like = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      clauses.push(
        `((SELECT t.prompt FROM turn_records t WHERE t.session_id = s.id ORDER BY t.rowid LIMIT 1)
            LIKE ? ESCAPE '\\'
          OR s.chat_id LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like);
    }

    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  /**
   * The transcript of one conversation, by its id.
   *
   * Separate from `load`, which takes the three fields the id is built from — a caller holding a
   * session row has the id already, and reconstructing a key from it just to look up the row it came
   * from is a round trip through a format that could drift.
   */
  messagesById(id: string): ChatMessage[] | null {
    const row = this.db
      .prepare<SessionRow>(
        "SELECT * FROM sessions WHERE id = ? OR chat_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(id, id);
    if (!row) return null;
    return this.messagesOf(row.id);
  }

  /**
   * One conversation's row, by id or by chat id.
   *
   * The same lenient lookup `messagesById` does, for the same reason: a caller holding a chat id from
   * a URL should not have to reconstruct a session key to ask whether the conversation exists.
   */
  find(id: string): Session | null {
    const row = this.db
      .prepare<SessionRow>(
        "SELECT * FROM sessions WHERE id = ? OR chat_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(id, id);
    return row ? toSession(row) : null;
  }

  /**
   * Delete one conversation outright.
   *
   * Distinct from `clear`, which empties the history and keeps the row so the agent stays in the
   * chat. This is the dashboard's delete: the conversation should stop being listed at all. Turn
   * records are the caller's to remove — they are a different table with a different lifetime, and a
   * store that reached into it would be two stores.
   */
  delete(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(id);
      return Number(this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes ?? 0) > 0;
    });
  }

  /**
   * Delete conversations untouched for `retentionDays`.
   *
   * `updated_at`, not `created_at`: a chat that has run daily for a year is the *least* disposable
   * row in the table, and keying on when it started would delete exactly that one first.
   *
   * `0` disables the sweep rather than deleting everything — the same off position `[attachments]
   * retention_days` uses. A knob whose zero means "wipe the database" is a knob that eventually
   * wipes a database.
   */
  sweep(retentionDays: number, now: number = Date.now()): number {
    if (retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * 24 * 60 * 60_000;
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM session_messages WHERE session_id IN (SELECT id FROM sessions WHERE updated_at < ?)").run(cutoff);
      return Number(this.db.prepare("DELETE FROM sessions WHERE updated_at < ?").run(cutoff).changes ?? 0);
    });
  }

}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    agentId: row.agent_id,
    chatId: row.chat_id,
    // The `gateway` column holds the instance id (`telegram:nouva`), which is what keys a
    // conversation — two bots on one platform are two different chats.
    gatewayId: row.gateway,
    sessionType: row.session_type as SessionType,
    status: row.status as Session["status"],
    contextTokenCount: row.context_token_count,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

/**
 * One stored message, or null when it is not one.
 *
 * Null rather than a throw: the alternative is an agent that can never answer in that chat again, in a
 * way only a SQL client can fix. Losing history is bad; being permanently stuck is worse.
 */
function parseMessage(text: string): ChatMessage | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as ChatMessage) : null;
  } catch {
    return null;
  }
}

/** What a stored message is compared by: 64 bits of its sha256 — a collision within one conversation is not a risk worth a wider column. */
function messageHash(text: string): string {
  return sha256Text(text).slice(0, 16);
}

/**
 * Which stored rows a save keeps: `kept` of them, starting at `from`, equal to the first `kept` messages it is
 * handed. Everything before `from` and after the kept run is deleted, and the messages after the first `kept`
 * are written after it. Pure, and the whole of what makes a turn's write small.
 *
 * What a conversation's saves look like, and what each keeps:
 * - a turn added messages: every stored row, and the new ones are written;
 * - the conversation reached its cap (`capStoredTurns`) and its oldest turn went: the rows after that turn;
 * - compaction replaced the history with a summary, or an older message was changed (a tool result trimmed to
 *   make room): the rows before the first that differs — compaction's summary differs at the first, so a
 *   compaction writes the conversation once, as every turn used to;
 * - `/new`: none.
 *
 * Of the runs that line up, the longest is kept, the earliest on a tie. A row without a hash (moved by `055`)
 * matches nothing, so it is written once more, with its hash.
 */
export function planKeep(stored: readonly (string | null)[], next: readonly string[]): { from: number; kept: number } {
  let best = { from: 0, kept: 0 };
  if (next.length === 0) return best;
  // A run starting at `from` keeps at most what is left after it: once that is no more than the best, stop.
  for (let from = 0; stored.length - from > best.kept; from += 1) {
    if (stored[from] !== next[0]) continue;
    let kept = 1;
    while (kept < next.length && from + kept < stored.length && stored[from + kept] === next[kept]) kept += 1;
    if (kept > best.kept) best = { from, kept };
  }
  return best;
}

/**
 * A conversation's history, as the daemon depends on it.
 *
 * Business logic takes this, never `SessionStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type SessionsPort = Port<SessionStore>;
