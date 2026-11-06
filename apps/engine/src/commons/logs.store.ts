/**
 * The log, on disk, for the days after the incident.
 *
 * `LogBuffer` holds the last 2000 lines in memory and argues — correctly — that a log *file* would
 * mean inventing rotation. This is the third option: a table, swept daily by the same retention pass
 * that already prunes sessions, audit rows and spilled tool output. What it buys over the ring is the
 * two things the ring cannot do: survive a restart, and still be there after a reconnect storm has
 * pushed the interesting part out.
 *
 * ## Writes are buffered, for the same reason the audit log's are
 *
 * A synchronous insert per line puts SQLite on the latency path of everything that logs — including
 * the tool loop and the gateway read path. Buffered and flushed a moment after the first line in
 * (`FlushTimer`), so a log line costs an array push and an idle daemon has no timer to wake for. Never throws: losing a line must not take down the work that produced it, and the one
 * place that could report the failure is the logger itself.
 *
 * ## `debug` is not stored
 *
 * It is written for somebody watching a terminal, it is the level that fires per keystroke of a
 * stream, and it would be most of the rows. It still reaches stdout, the journal and the ring.
 */

import { createLogger, type LogEntry, type LogLevel, type Port} from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";
import { FlushTimer } from "./flush-timer.ts";

const log = createLogger("logs");

const FLUSH_INTERVAL_MS = 2000;
/** Beyond this, flush immediately rather than holding an unbounded buffer. */
const MAX_BUFFER = 500;
/**
 * Rows kept whatever the retention says. A stored line averages a few hundred bytes, so this is tens of megabytes —
 * days of an ordinary daemon's info lines, and a ceiling under a storm.
 */
const LOG_MAX_ROWS = 200_000;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
/** Below this is not written down. See the note above. */
const STORED_FLOOR = LEVEL_ORDER.info;

export interface StoredLog {
  id: number;
  ts: number;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
  agentId?: string;
  chatId?: string;
}

export interface StoredLogQuery {
  limit?: number;
  /** Only entries older than this id — the "load more" cursor. */
  before?: number;
  /** Only entries at or after this time, in epoch ms — the last day's, say (`llm/helper-trouble.ts`). */
  since?: number;
  minLevel?: LogLevel;
  component?: string;
  /** Matched against the message and the JSON tail, case-insensitively. */
  search?: string;
}

interface Row {
  id: number;
  ts: number;
  level: string;
  component: string;
  message: string;
  data: string | null;
  agent_id: string | null;
  chat_id: string | null;
}

export class LogStore {
  private buffer: LogEntry[] = [];
  private readonly flushing = new FlushTimer(() => this.flush(), FLUSH_INTERVAL_MS, log);
  /** Rows this store has inserted or deleted since it was made — see `rowsWritten`. */
  private written = 0;

  constructor(private readonly db: SqliteDb) {}

  start(): void {
    this.flushing.start();
  }

  /**
   * Rows this store has written or deleted since it was made. The daemon's own log lines are not what a database
   * snapshot keeps — they go after three days — and taking a snapshot logs a line: counted as a write, every snapshot
   * would make the next one look due (`startDatabaseBackups`).
   */
  rowsWritten(): number {
    return this.written;
  }

  /** Flush and stop. Called during shutdown, before the database closes. */
  stop(): void {
    this.flushing.stop();
    this.flush();
  }

  /**
   * Sink for the logger.
   *
   * A bound property rather than a method, so it can be handed to `addLogSink` without a wrapper
   * that would be the only thing standing between a logged line and a `this` of `undefined`.
   */
  sink = (entry: LogEntry): void => {
    if (LEVEL_ORDER[entry.level] < STORED_FLOOR) return;
    this.buffer.push(entry);
    if (this.buffer.length >= MAX_BUFFER) this.flush();
    else this.flushing.arm();
  };

  flush(): void {
    this.flushing.disarm();
    if (this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];

    try {
      const statement = this.db.prepare(
        `INSERT INTO log_entries (ts, level, component, message, data, agent_id, chat_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      this.db.transaction(() => {
        for (const entry of pending) {
          statement.run(
            // The logger writes an ISO string; the column is epoch millis, because every query here
            // is a range over time and a string comparison is not one.
            Date.parse(entry.timestamp) || Date.now(),
            entry.level,
            entry.component,
            entry.message,
            // `turn_id` back into the tail: the table has no column for it, and dropping it would lose the one id a
            // turn's lines share (D2).
            storedData(entry),
            entry.agent_id ?? null,
            entry.chat_id ?? null,
          );
        }
      });
      this.written += pending.length;
    } catch (err) {
      // Never throw: the caller is whatever was logging, which includes shutdown paths. Reported
      // through the logger, whose own sink drops nothing on the floor because this buffer is
      // append-only and the next flush will try again with the new line.
      log.error("log flush failed", { error: String(err), dropped: pending.length });
    }
  }

  /** Newest first — the order a person scrolls a log they are looking *for* something in. */
  query(options: StoredLogQuery = {}): StoredLog[] {
    const { where, params } = filter(options);
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
    return this.db
      .prepare<Row>(`SELECT * FROM log_entries ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit)
      .map(toStored);
  }

  count(options: Omit<StoredLogQuery, "limit" | "before"> = {}): number {
    const { where, params } = filter(options);
    const row = this.db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM log_entries ${where}`)
      .get(...params);
    return row?.n ?? 0;
  }

  /**
   * Which components have logged anything, most talkative first.
   *
   * So the filter is a list of what is actually there rather than a text box somebody has to guess
   * `gateway.telegram:bot` into. Bounded — a daemon has tens of components, not thousands.
   */
  components(): { component: string; entries: number }[] {
    return this.db
      .prepare<{ component: string; n: number }>(
        `SELECT component, COUNT(*) AS n FROM log_entries
         GROUP BY component ORDER BY n DESC LIMIT 100`,
      )
      .all()
      .map((row) => ({ component: row.component, entries: row.n }));
  }

  /** The window each level covers right now, so the page can say how far back it can look. */
  span(): { oldest: number | null; newest: number | null } {
    const row = this.db
      .prepare<{ oldest: number | null; newest: number | null }>(
        "SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM log_entries",
      )
      .get();
    return { oldest: row?.oldest ?? null, newest: row?.newest ?? null };
  }

  /**
   * Drop entries past the retention window, then the oldest past `maxRows`. `0` days keeps every day — up to the cap.
   *
   * The cap is the half time alone could not give (D17): days bound the table only at the rate the daemon logs, and
   * the day it logs fastest — a reconnect storm, a loop — is the day the disk fills, on a box whose disk is a card.
   * The same reason the in-memory ring is a ring.
   */
  sweep(retentionDays: number, now: number = Date.now(), maxRows: number = LOG_MAX_ROWS): number {
    // Flushed first, so a sweep cannot race a pending write into a range it has already deleted.
    this.flush();
    try {
      let removed = 0;
      if (retentionDays > 0) {
        const cutoff = now - retentionDays * 24 * 60 * 60_000;
        removed += Number(this.db.prepare("DELETE FROM log_entries WHERE ts < ?").run(cutoff).changes ?? 0);
      }
      removed += Number(
        this.db
          // By id, which only grows: everything more than `maxRows` below the newest. A range on the rowid, no scan.
          .prepare("DELETE FROM log_entries WHERE id <= (SELECT MAX(id) FROM log_entries) - ?")
          .run(maxRows).changes ?? 0,
      );
      this.written += removed;
      return removed;
    } catch (err) {
      log.error("log sweep failed", { error: String(err) });
      return 0;
    }
  }
}

/** The structured tail as stored: the line's data, with the turn id it was written in when it had one. */
function storedData(entry: LogEntry): string | null {
  const data = entry.turn_id ? { ...entry.data, turn_id: entry.turn_id } : entry.data;
  return data && Object.keys(data).length > 0 ? JSON.stringify(data) : null;
}

function filter(options: StoredLogQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.minLevel) {
    const allowed = (Object.keys(LEVEL_ORDER) as LogLevel[]).filter(
      (level) => LEVEL_ORDER[level] >= LEVEL_ORDER[options.minLevel!],
    );
    // An `IN` over the names rather than a comparison, because the column holds the word — see the
    // migration for why it is stored that way.
    clauses.push(`level IN (${allowed.map(() => "?").join(", ")})`);
    params.push(...allowed);
  }
  if (options.component) {
    clauses.push("component = ?");
    params.push(options.component);
  }
  if (options.before !== undefined) {
    clauses.push("id < ?");
    params.push(options.before);
  }
  if (options.since !== undefined) {
    clauses.push("ts >= ?");
    params.push(options.since);
  }
  const search = options.search?.trim();
  if (search) {
    // Escaped, because `%` and `_` are wildcards and somebody searching for `100%` means it.
    const like = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    clauses.push("(message LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function toStored(row: Row): StoredLog {
  let data: Record<string, unknown> | undefined;
  if (row.data) {
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      // A row written by a version that framed it differently. Shown as text rather than dropped —
      // the line is still the thing somebody came here to read.
      data = { raw: row.data };
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    level: (row.level as LogLevel) ?? "info",
    component: row.component,
    message: row.message,
    ...(data ? { data } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.chat_id ? { chatId: row.chat_id } : {}),
  };
}

/**
 * The daemon's own log, as the daemon depends on it.
 *
 * Business logic takes this, never `LogStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type LogsPort = Port<LogStore>;
