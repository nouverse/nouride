/**
 * What turns do, as one append-only stream — and whoever is watching, handed each row once it is written.
 *
 * One stream rather than a table per kind of record. Before 0.7.4 a tool call wrote a step row, an audit row and an
 * activity event, and a model call a usage row — each in its own table, in its own order — and the dashboard polled
 * the steps every half second to draw a turn still running. A reader that wants a turn whole (the dashboard's
 * conversation view, `nouride events`, an editor driving a conversation) needs one order and one place to resume
 * from. So a turn's steps, its partial answer, its tool calls as audited and its model calls as metered each land
 * here as a row with one cursor, `seq` (`069_baseline.sql`), and what a row of each kind carries is the contract in
 * `packages/shared/src/types/events.ts`. `list` reads a page of them; `subscribe` is the live half — called
 * with every row matching its filter, after the row is committed, so a subscriber that read up to `seq` N and
 * then subscribed misses nothing it did not already have, provided it subscribes first and drops what it has.
 *
 * Writing never throws. A watcher that can break a turn is worse than none, the same rule `TurnRecorder` keeps:
 * a full disk costs the stream a row, never the person their answer.
 *
 * One transaction is one announcement. `batch` runs writes as one transaction and tells the watchers after it
 * commits, in the order the rows were written; a batch inside a batch joins it, and a batch that throws is
 * rolled back and announced to nobody. A row appended outside any batch is its own commit, announced at once.
 * Every write the daemon makes together with a row — a turn's record and its event, a tool's audit row and its
 * result, the settle of a turn — goes through `batch`, so a follower is never handed a row that is not there.
 *
 * `seq` only moves forward: `AUTOINCREMENT`, so SQLite never hands out a number twice, the
 * newest rows deleted or not, and `latest` is the highest it ever gave. Before, a rowid alias handed out one more
 * than the highest row *left*, and the newest row had to be blanked rather than deleted or its number went to the
 * next one — which a follower already held, and dropped as old. Rows are never edited. A database restored to an
 * older state goes back on its numbers anyway; its `epoch` changes when it does (`db/epoch.ts`).
 *
 * A row that could not be written is counted (`dropped`), said at warn — the first, then a count once a minute — and
 * named on `/health`: logged at debug, a full disk emptied the stream with nothing on a default install saying so.
 */

import { clip, createLogger, EVENT_CONTRACT, eventProblems, type EventCut, type EventField, type TurnEventData, type TurnEventKind } from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";

const log = createLogger("events");

/** At most this much JSON per row: a tool's arguments are cut to fit rather than a row refused. */
const DATA_MAX_CHARS = 8_000;
/** Of each kind, the keys never cut or retyped — what a reader pairs and orders by (`identity` in the contract). */
const IDENTITY = new Map(
  Object.entries(EVENT_CONTRACT.kinds as Record<string, Record<string, EventField>>).map(([kind, fields]) => [
    kind,
    new Set(Object.entries(fields).filter(([, field]) => field.identity).map(([key]) => key)),
  ]),
);
/** A page of `list`, when the caller names none. */
const PAGE = 200;
/** After the first failure is said, how often the count of those since is. */
const LOSS_REPORT_MS = 60_000;

/** One row to write: a kind of the contract, and the data that kind carries (`EVENT_CONTRACT`, `@nouride/shared`). */
export type EventInput = {
  [K in TurnEventKind]: {
    kind: K;
    turnId: string;
    agentId?: string | undefined;
    gatewayId?: string | undefined;
    chatId?: string | undefined;
    /** With `truncated` and `cut` where the writer cut a value itself — a step's text, a prompt. */
    data: TurnEventData[K] & EventCut;
  };
}[TurnEventKind];

export interface EventRow {
  seq: number;
  at: number;
  turnId: string | null;
  agentId: string | null;
  gatewayId: string | null;
  chatId: string | null;
  kind: string;
  data: Record<string, unknown>;
}

/** Which events: after a cursor, of one turn or one conversation — a chat, on one connection or any — of some kinds. */
export interface EventFilter {
  since?: number;
  turnId?: string;
  gatewayId?: string;
  chatId?: string;
  kinds?: readonly string[];
  limit?: number;
  /** The newest page rather than the oldest — still oldest first within it. What a bare `nouride events` shows. */
  newest?: boolean;
}

/** A moment of a turn that is not a row: the turn, where it runs, and its line (`EventsPort.pulse`). */
export interface Pulse {
  turnId: string;
  agentId?: string;
  gatewayId?: string;
  chatId?: string;
  text: string;
}

export interface EventsPort {
  /** Which life of the database the cursors belong to (`db/epoch.ts`); empty where nobody said. */
  readonly epoch: string;
  /** The row's `seq`, or 0 when it could not be written. */
  append(input: EventInput): number;
  /**
   * `fn` as one transaction, its rows announced after the commit, in order. Joins a batch already open. Never
   * throws for the transaction itself — a COMMIT that fails loses the rows, says so in the log and returns what
   * `fn` returned — only rethrows what `fn` threw, rolled back and announced to nobody. `fn` must be synchronous.
   */
  batch<T>(fn: () => T): T;
  list(filter: EventFilter): EventRow[];
  /** The newest row's `seq`, or 0: where a stream that wants only what comes next starts. */
  latest(): number;
  /** The oldest row's `seq`, or 0: a cursor before it has missed rows that are gone. */
  oldest(): number;
  /** Rows that could not be written, or were rolled back by a commit that failed, since this store was made. */
  dropped(): number;
  /** `onPulse`, when given, is also handed every pulse in the filter's turn or conversation — see `pulse`. */
  subscribe(filter: EventFilter, listener: (row: EventRow) => void, onPulse?: (pulse: Pulse) => void): () => void;
  /**
   * Said to whoever is watching that turn or conversation now, and written nowhere: a model call under way (the
   * stream's `thinking` frame, 1.2). No `seq`, no replay — a reader that was not there did not miss a row.
   */
  pulse(pulse: Pulse): void;
  sweep(before: number): number;
  /** Every row of these turns, gone — a deleted conversation. How many. */
  forget(turnIds: readonly string[]): number;
}

interface Row {
  seq: number;
  at: number;
  turn_id: string | null;
  agent_id: string | null;
  gateway_id: string | null;
  chat_id: string | null;
  kind: string;
  data: string;
}

export class EventStore implements EventsPort {
  private readonly watchers = new Set<{ scope: Scope; listener: (row: EventRow) => void; onPulse?: ((pulse: Pulse) => void) | undefined }>();
  /** How many batches are open, and the rows written inside them — announced when the outermost commits. */
  private depth = 0;
  private pending: EventRow[] = [];
  /** Rows lost, and when the loss was last said and how many were then. */
  private lost = 0;
  private lossSaidAt = 0;
  private lossSaid = 0;

  /** Which life of the database the cursors belong to (`db/epoch.ts`). */
  readonly epoch: string;
  /** Refuse a row the contract does not describe — for tests, where a writer that drifts should fail. */
  private readonly strict: boolean;
  /** Each problem said once, in production, however often a writer repeats it. */
  private readonly saidProblems = new Set<string>();

  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
    options: { epoch?: string; strict?: boolean } = {},
  ) {
    this.epoch = options.epoch ?? "";
    this.strict = options.strict ?? false;
  }

  /**
   * What is wrong with a row against the contract (`eventProblems`), checked as it is written: a strict store throws,
   * so every test that writes through one holds the daemon's writers to what readers are promised; otherwise each
   * problem is said once, at warn, and the row is written — a stream with an odd row beats a turn that fails.
   */
  private check(input: EventInput): void {
    const problems = eventProblems(input.kind, input.data as unknown as Record<string, unknown>);
    if (problems.length === 0) return;
    if (this.strict) throw new Error(`an event row the contract does not describe: ${problems.join("; ")}`);
    for (const problem of problems) {
      if (this.saidProblems.has(problem)) continue;
      this.saidProblems.add(problem);
      log.warn("an event row the contract does not describe", { kind: input.kind, problem });
    }
  }

  dropped(): number {
    return this.lost;
  }

  /** `count` rows lost: the first loss said at once, then the count since at most once a minute. */
  private noteLoss(count: number, error: unknown, kind?: string): void {
    this.lost += count;
    const at = this.now();
    if (this.lossSaid > 0 && at - this.lossSaidAt < LOSS_REPORT_MS) return;
    log.warn("event rows were not recorded, so the stream is missing them", {
      lost: this.lost - this.lossSaid,
      total: this.lost,
      ...(kind ? { kind } : {}),
      error: String(error),
    });
    this.lossSaidAt = at;
    this.lossSaid = this.lost;
  }

  append(input: EventInput): number {
    this.check(input);
    let row: EventRow;
    try {
      const data = bounded(input.kind, input.data as unknown as Record<string, unknown>);
      const at = this.now();
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO events (at, turn_id, agent_id, gateway_id, chat_id, kind, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(at, input.turnId, input.agentId ?? null, input.gatewayId ?? null, input.chatId ?? null, input.kind, JSON.stringify(data));
      row = { seq: Number(lastInsertRowid), at, turnId: input.turnId, agentId: input.agentId ?? null, gatewayId: input.gatewayId ?? null, chatId: input.chatId ?? null, kind: input.kind, data };
    } catch (err) {
      this.noteLoss(1, err, input.kind);
      return 0;
    }
    if (this.depth > 0) {
      this.pending.push(row);
    } else {
      // Inside a transaction this store did not open, its commit is not known here: said at once, as before batches.
      if (this.db.inTransaction()) log.debug("an event announced inside a transaction it is not part of", { kind: input.kind });
      this.announce([row]);
    }
    return row.seq;
  }

  batch<T>(fn: () => T): T {
    const outermost = this.depth === 0;
    const mark = this.pending.length;
    let ran = false;
    let value: T | undefined;
    this.depth += 1;
    try {
      this.db.transaction(() => {
        value = fn();
        if (value instanceof Promise || typeof (value as { then?: unknown } | undefined)?.then === "function") {
          throw new Error("a batch holds a transaction, which must not span an await: pass it synchronous work");
        }
        ran = true;
      });
    } catch (err) {
      // Rolled back: what this batch wrote — and only that, when it is a savepoint inside another — is not there.
      const lost = this.pending.length - mark;
      this.pending.length = mark;
      if (!ran) throw err;
      // `fn` finished and the transaction did not: a COMMIT that failed (a full disk) costs the rows, not the work.
      this.noteLoss(lost, err);
    } finally {
      this.depth -= 1;
    }
    if (outermost) {
      const rows = this.pending;
      this.pending = [];
      this.announce(rows);
    }
    return value as T;
  }

  /** Each row to every watcher whose filter it matches, in order. One watcher's failure is its own. */
  private announce(rows: readonly EventRow[]): void {
    for (const row of rows) {
      for (const watcher of this.watchers) {
        if (!inScope(row, watcher.scope)) continue;
        try {
          watcher.listener(row);
        } catch (err) {
          log.warn("an event watcher failed", { kind: row.kind, error: String(err) });
        }
      }
    }
  }

  /** Oldest first, after `since`: the replay a stream starts with, and `nouride events`. */
  list(filter: EventFilter): EventRow[] {
    const asked = scope(filter);
    // The kinds as one JSON array, read by `json_each`: one statement for any number of them, or none.
    const kinds = asked.kinds ? JSON.stringify(asked.kinds) : null;
    const since = asked.since;
    const limit = Math.min(Math.max(1, filter.limit ?? PAGE), 1_000);
    if (filter.newest) return this.newest(asked, kinds, limit).map(toEvent);
    const rows = asked.turnId
      ? this.db
          .prepare<Row>(
            `SELECT seq, at, turn_id, agent_id, gateway_id, chat_id, kind, data FROM events
             WHERE turn_id = ? AND seq > ? AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
             ORDER BY seq LIMIT ?`,
          )
          .all(asked.turnId, since, kinds, kinds, limit)
      : asked.gatewayId !== undefined && asked.chatId !== undefined
        ? this.db
            .prepare<Row>(
              `SELECT seq, at, turn_id, agent_id, gateway_id, chat_id, kind, data FROM events
               WHERE gateway_id = ? AND chat_id = ? AND seq > ? AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
               ORDER BY seq LIMIT ?`,
            )
            .all(asked.gatewayId, asked.chatId, since, kinds, kinds, limit)
        : asked.chatId !== undefined
          ? this.db
              .prepare<Row>(
                `SELECT seq, at, turn_id, agent_id, gateway_id, chat_id, kind, data FROM events
                 WHERE seq > ? AND chat_id = ? AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
                 ORDER BY seq LIMIT ?`,
              )
              .all(since, asked.chatId, kinds, kinds, limit)
          : this.db
            .prepare<Row>(
              `SELECT seq, at, turn_id, agent_id, gateway_id, chat_id, kind, data FROM events
               WHERE seq > ? AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
               ORDER BY seq LIMIT ?`,
            )
            .all(since, kinds, kinds, limit);
    return rows.map(toEvent);
  }

  /** The newest `limit` rows of a scope, oldest first — the same four reads as `list`, from the other end. */
  private newest(asked: Scope, kinds: string | null, limit: number): Row[] {
    const since = asked.since;
    return asked.turnId
      ? this.db
          .prepare<Row>(
            `SELECT * FROM (SELECT seq, at, turn_id, agent_id, gateway_id, chat_id, kind, data FROM events
             WHERE turn_id = ? AND seq > ? AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
             ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
          )
          .all(asked.turnId, since, kinds, kinds, limit)
      : asked.gatewayId !== undefined && asked.chatId !== undefined
        ? this.db
            .prepare<Row>(
              `SELECT * FROM (SELECT seq, at, turn_id, agent_id, gateway_id, chat_id, kind, data FROM events
               WHERE gateway_id = ? AND chat_id = ? AND seq > ? AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
               ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
            )
            .all(asked.gatewayId, asked.chatId, since, kinds, kinds, limit)
        : asked.chatId !== undefined
          ? this.db
              .prepare<Row>(
                `SELECT * FROM (SELECT seq, at, turn_id, agent_id, gateway_id, chat_id, kind, data FROM events
                 WHERE seq > ? AND chat_id = ? AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
                 ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
              )
              .all(since, asked.chatId, kinds, kinds, limit)
          : this.db
              .prepare<Row>(
                `SELECT * FROM (SELECT seq, at, turn_id, agent_id, gateway_id, chat_id, kind, data FROM events
                 WHERE seq > ? AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
                 ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
              )
              .all(since, kinds, kinds, limit);
  }

  /** The highest `seq` ever given — SQLite's own count, which a deleted row does not lower. */
  latest(): number {
    return this.db.prepare<{ seq: number | null }>("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()?.seq ?? 0;
  }

  oldest(): number {
    return this.db.prepare<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events").get()?.seq ?? 0;
  }

  /** Called with every row matching `filter` once it is written. The function given back stops it. */
  subscribe(filter: EventFilter, listener: (row: EventRow) => void, onPulse?: (pulse: Pulse) => void): () => void {
    const watcher = { scope: scope(filter), listener, onPulse };
    this.watchers.add(watcher);
    return () => void this.watchers.delete(watcher);
  }

  /** To each watcher that asked for pulses and follows this turn or conversation — whatever its cursor or kinds. */
  pulse(pulse: Pulse): void {
    for (const watcher of this.watchers) {
      if (!watcher.onPulse || !pulseInScope(pulse, watcher.scope)) continue;
      try {
        watcher.onPulse(pulse);
      } catch (err) {
        log.warn("an event watcher failed", { kind: "pulse", error: String(err) });
      }
    }
  }

  /** What is older than `before` — the turns' retention, swept with them. A box idle for the whole window keeps its count. */
  sweep(before: number): number {
    return this.db.prepare("DELETE FROM events WHERE at < ?").run(before).changes;
  }

  /** Every row of these turns. The newest among them too: its number is not handed out again. */
  forget(turnIds: readonly string[]): number {
    if (turnIds.length === 0) return 0;
    return this.db.prepare("DELETE FROM events WHERE turn_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(turnIds)).changes;
  }
}

/**
 * A filter as both readers ask it — `list` of the table and `subscribe` of each row as it is written — so the two
 * cannot answer one filter differently. One turn wins over a conversation; a conversation is a chat on one
 * connection, or that chat on any when no gateway is named; a gateway alone names nothing and is not read.
 */
interface Scope {
  since: number;
  turnId?: string;
  chatId?: string;
  gatewayId?: string;
  kinds: readonly string[] | null;
}

function scope(filter: EventFilter): Scope {
  const kinds = filter.kinds?.length ? filter.kinds : null;
  const since = filter.since ?? 0;
  if (filter.turnId) return { since, turnId: filter.turnId, kinds };
  if (filter.chatId) return { since, chatId: filter.chatId, ...(filter.gatewayId ? { gatewayId: filter.gatewayId } : {}), kinds };
  return { since, kinds };
}

/** Whether a row is one a watcher asked for: the questions `list` asks of the table, of one row. */
function inScope(row: EventRow, asked: Scope): boolean {
  if (row.seq <= asked.since) return false;
  if (asked.turnId !== undefined && row.turnId !== asked.turnId) return false;
  if (asked.chatId !== undefined && row.chatId !== asked.chatId) return false;
  if (asked.gatewayId !== undefined && row.gatewayId !== asked.gatewayId) return false;
  return asked.kinds === null || asked.kinds.includes(row.kind);
}

/** Whether a pulse is one a watcher's turn or conversation covers — the questions `inScope` asks, but of where alone. */
function pulseInScope(pulse: Pulse, asked: Scope): boolean {
  if (asked.turnId !== undefined) return pulse.turnId === asked.turnId;
  if (asked.chatId !== undefined && pulse.chatId !== asked.chatId) return false;
  return asked.gatewayId === undefined || pulse.gatewayId === asked.gatewayId;
}

/**
 * The data as written, or — over the bound — with its strings cut, everywhere but its identity keys. A value keeps
 * its type: arguments stay an object, a list stays a list; only the strings inside get shorter, harder each pass.
 * The keys cut are listed in `cut`, with `truncated: true`. Only if that is not enough does a key go — never one of
 * the identity keys, which is how a step of escaped control characters used to lose its number.
 */
function bounded(kind: string, data: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(data).length <= DATA_MAX_CHARS) return data;
  const identity = IDENTITY.get(kind) ?? new Set<string>();
  for (const limit of [2_000, 500, 100]) {
    const out: Record<string, unknown> = {};
    const cut: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      const shortened = identity.has(key) ? { value, cut: false } : shorten(value, limit);
      out[key] = shortened.value;
      if (shortened.cut) cut.push(key);
    }
    const result = { ...out, truncated: true, cut };
    if (JSON.stringify(result).length <= DATA_MAX_CHARS) return result;
  }
  const kept = Object.fromEntries(Object.entries(data).filter(([key]) => identity.has(key)));
  return { ...kept, truncated: true, cut: Object.keys(data).filter((key) => !identity.has(key)) };
}

function shorten(value: unknown, limit: number): { value: unknown; cut: boolean } {
  if (typeof value === "string") return value.length > limit ? { value: clip(value, limit, limit), cut: true } : { value, cut: false };
  if (value === null || typeof value !== "object") return { value, cut: false };
  const entries = Array.isArray(value) ? value.map((item, index) => [index, item] as const) : Object.entries(value);
  let cut = false;
  const out = entries.map(([key, item]) => {
    const shortened = shorten(item, limit);
    cut ||= shortened.cut;
    return [key, shortened.value] as const;
  });
  return { value: Array.isArray(value) ? out.map(([, item]) => item) : Object.fromEntries(out), cut };
}

function toEvent(row: Row): EventRow {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    // Written by this store as JSON; a row that is not is shown empty rather than failing the page.
  }
  return { seq: row.seq, at: row.at, turnId: row.turn_id, agentId: row.agent_id, gatewayId: row.gateway_id, chatId: row.chat_id, kind: row.kind, data };
}
