/**
 * Audit log — §17.2 item 1.
 *
 * Every tool execution, approval answer and config change, with a timestamp and an actor.
 * The question it exists to answer is "who made this happen, and when" — after the fact,
 * when the chat has scrolled away.
 *
 * Writes are buffered and flushed a moment after the first one in (`FlushTimer`). Not for throughput: a synchronous insert inside
 * the tool loop puts SQLite on the latency path of every tool call, and an audit log that slows
 * the thing it observes gets turned off.
 */

import { createLogger, newId, type LogEntry, type Port} from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";
import { FlushTimer } from "./flush-timer.ts";

const log = createLogger("audit");

const FLUSH_INTERVAL_MS = 2000;
/** Beyond this, flush immediately rather than holding an unbounded buffer. */
const MAX_BUFFER = 200;

export interface AuditEntry {
  action: string;
  agentId?: string;
  /** Who caused it: a sender id, a dashboard user, "system", or "cron". */
  actor?: string;
  gatewayId?: string;
  chatId?: string;
  /** The turn it happened in (D2) — a `tool_exec` row's, or an error logged during one. */
  turnId?: string;
  details?: Record<string, unknown>;
}

/** When a skill was last read, and since when its reads have been kept (`skill_reads`). */
export interface SkillRead {
  /** The last read; null when there has been none since `since`. */
  readAt: number | null;
  since: number;
}

/** An absolute `SKILL.md` path inside a tool call's recorded arguments — what `read` and `exec cat` of a skill leave. */
const SKILL_PATH = /\/[^\s"'`\\;|&<>()]*\/SKILL\.md/g;

export class AuditLog {
  private buffer: (AuditEntry & { timestamp: number })[] = [];
  private readonly flushing = new FlushTimer(() => this.flush(), FLUSH_INTERVAL_MS, log);

  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Shutdown flushes whatever is buffered (`stop`); until then a record arms one flush (`FlushTimer`). */
  start(): void {
    this.flushing.start();
  }

  /** Flush and stop. Called during shutdown, before the database closes. */
  stop(): void {
    this.flushing.stop();
    this.flush();
  }

  record(entry: AuditEntry): void {
    this.buffer.push({ ...entry, timestamp: this.now() });
    if (this.buffer.length >= MAX_BUFFER) this.flush();
    else this.flushing.arm();
  }

  /**
   * Sink for the logger, so error-level lines land in the audit table too (§15.3 SPEC).
   *
   * Deliberately narrow: only errors. Piping every debug line through SQLite would turn the
   * audit trail into a log file with worse ergonomics.
   */
  logSink = (entry: LogEntry): void => {
    if (entry.level !== "error") return;
    this.record({
      action: "error",
      ...(entry.agent_id ? { agentId: entry.agent_id } : {}),
      ...(entry.chat_id ? { chatId: entry.chat_id } : {}),
      ...(entry.turn_id ? { turnId: entry.turn_id } : {}),
      actor: "system",
      details: { component: entry.component, message: entry.message, ...entry.data },
    });
  };

  flush(): void {
    this.flushing.disarm();
    if (this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];

    try {
      const statement = this.db.prepare(
        `INSERT INTO audit_log (id, timestamp, agent_id, actor, action, details, gateway, chat_id, turn_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const read = this.db.prepare(
        `INSERT INTO skill_reads (path, watched_since, read_at) VALUES (?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET read_at = max(coalesce(skill_reads.read_at, 0), excluded.read_at)`,
      );
      this.db.transaction(() => {
        for (const entry of pending) {
          const details = entry.details ? JSON.stringify(entry.details) : null;
          statement.run(
            newId("aud"),
            entry.timestamp,
            entry.agentId ?? null,
            entry.actor ?? "system",
            entry.action,
            details,
            entry.gatewayId ?? null,
            entry.chatId ?? null,
            entry.turnId ?? null,
          );
          // Kept beside the row, because the row goes at `audit_days` and when a skill was last read must not.
          if (entry.action === "tool_exec" && details) {
            for (const path of new Set(details.match(SKILL_PATH))) read.run(path, entry.timestamp, entry.timestamp);
          }
        }
      });
    } catch (err) {
      // Never throw from here: the caller is a tool loop or a shutdown sequence, and losing an
      // audit line must not take down the work being audited. Reported through the logger,
      // which is not routed back into this buffer for non-error levels.
      log.error("audit flush failed", { error: String(err), dropped: pending.length });
    }
  }

  /**
   * Delete entries older than `retentionDays`. Returns how many went.
   *
   * The buffer is flushed first, so a sweep cannot race a pending write into a table it has already
   * decided about — the row would land after the cutoff was applied and survive an extra day. Harmless,
   * but the alternative costs one function call.
   *
   * `0` keeps everything, matching the other retention knobs. `idx_audit_ts` makes the delete a range
   * scan rather than a table walk, which matters precisely when the sweep matters — a table nobody
   * pruned for months.
   */
  sweep(retentionDays: number, now: number = this.now()): number {
    if (retentionDays <= 0) return 0;
    this.flush();
    const cutoff = now - retentionDays * 24 * 60 * 60_000;
    try {
      const result = this.db.prepare("DELETE FROM audit_log WHERE timestamp < ?").run(cutoff);
      return Number(result.changes ?? 0);
    } catch (err) {
      // Same reasoning as `flush`: this runs on a background timer, and a failed cleanup must not
      // take down the daemon it was cleaning up after.
      log.error("audit sweep failed", { error: String(err) });
      return 0;
    }
  }

  /**
   * When each skill was last read, and since when that has been watched, keyed by path.
   *
   * "Which skills does this agent actually use, and which are just prompt budget": one line in the
   * prompt per skill is cheap; twenty of them that nobody has ever opened is not. Matched on the path
   * appearing anywhere in the recorded arguments rather than on a specific tool: a skill is read by
   * `read` most of the time and by `exec cat` when a sandbox refuses, and both count as use.
   */
  skillReads(paths: string[]): Map<string, SkillRead> {
    const reads = new Map<string, SkillRead>();
    if (paths.length === 0) return reads;

    // Flushed first: a skill read seconds ago is still in the buffer, and reporting it as never used
    // is the kind of small lie that makes a dashboard untrustworthy.
    this.flush();

    const rows = this.db
      .prepare<{ path: string; watched_since: number; read_at: number | null }>(
        "SELECT path, watched_since, read_at FROM skill_reads WHERE path IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(paths));
    for (const row of rows) reads.set(row.path, { readAt: row.read_at, since: row.watched_since });

    const unseen = paths.filter((path) => !reads.has(path));
    if (unseen.length > 0) for (const [path, read] of this.startWatching(unseen)) reads.set(path, read);
    return reads;
  }

  /**
   * A path asked about for the first time: what the audit log still holds of it, kept from now on.
   *
   * Its reads before this — before 0.7.27, or before anything asked — are only in the audit log, and only its newest
   * rows are searched. So the watch starts at the oldest row searched, not at the skill's birth: "not read since then"
   * is what the log can show, and the weekly review archiving on "never read" was archiving what it could not see.
   */
  private startWatching(paths: string[]): Map<string, SkillRead> {
    const rows = this.db
      .prepare<{ timestamp: number; details: string | null }>(
        "SELECT timestamp, details FROM audit_log WHERE action = 'tool_exec' ORDER BY timestamp DESC LIMIT 5000",
      )
      .all();

    const found = new Map<string, number>();
    let oldest = this.now();
    for (const row of rows) {
      oldest = row.timestamp;
      if (!row.details) continue;
      for (const path of paths) {
        if (!found.has(path) && row.details.includes(path)) found.set(path, row.timestamp);
      }
      if (found.size === paths.length) break;
    }

    const insert = this.db.prepare("INSERT INTO skill_reads (path, watched_since, read_at) VALUES (?, ?, ?) ON CONFLICT (path) DO NOTHING");
    const reads = new Map<string, SkillRead>();
    this.db.transaction(() => {
      for (const path of paths) {
        const read = { readAt: found.get(path) ?? null, since: oldest };
        insert.run(path, read.since, read.readAt);
        reads.set(path, read);
      }
    });
    return reads;
  }

  /** Recent entries, newest first — for the CLI and the dashboard. */
  recent(limit = 50, agentId?: string): AuditEntry[] {
    this.flush();
    const rows = agentId
      ? this.db
          .prepare<Row>(
            "SELECT * FROM audit_log WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?",
          )
          .all(agentId, limit)
      : this.db
          .prepare<Row>("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?")
          .all(limit);
    return rows.map(toEntry);
  }

  /**
   * The newest entries of a few actions — the Access page's history is the eight `access_*` ones.
   *
   * Walks `idx_audit_ts` newest first and stops at `limit`: rare actions in a table of tool calls cost a
   * longer walk, never a sort.
   */
  ofActions(actions: readonly string[], limit = 200): (AuditEntry & { timestamp: number })[] {
    if (actions.length === 0) return [];
    this.flush();
    return this.db
      .prepare<Row>(`SELECT * FROM audit_log WHERE action IN (${marks(actions)}) ORDER BY timestamp DESC LIMIT ?`)
      .all(...actions, limit)
      .map(toEntry);
  }

  /**
   * The knowledge documents opened in a chat between two times, oldest first: each `memory_read` of a `document` that
   * answered, as `<collection>/<path>` (0.8.23). What a conversation opened is kept on it when it is filed, and the
   * memory graph draws it (KNOWLEDGE_BASE §12). Walks `idx_audit_ts` over the window, a day's calls at most.
   */
  documentsOpened(gatewayId: string, chatId: string, after: number, until: number): { at: number; document: string }[] {
    this.flush();
    const rows = this.db
      .prepare<{ timestamp: number; details: string | null }>(
        "SELECT timestamp, details FROM audit_log WHERE timestamp > ? AND timestamp <= ? AND action = 'tool_exec' AND gateway = ? AND chat_id = ? ORDER BY timestamp",
      )
      .all(after, until, gatewayId, chatId);
    const out: { at: number; document: string }[] = [];
    for (const row of rows) {
      const document = openedDocument(row.details);
      if (document) out.push({ at: row.timestamp, document });
    }
    return out;
  }
}

/** A `memory_read` that opened a document and answered, as `<collection>/<path>`; null for any other call. */
function openedDocument(details: string | null): string | null {
  if (!details || !details.includes('"memory_read"')) return null;
  try {
    const parsed = JSON.parse(details) as { tool?: unknown; args?: { document?: unknown }; error?: unknown };
    const item = parsed.tool === "memory_read" && parsed.error === false ? parsed.args?.document : undefined;
    const match = typeof item === "string" ? /^knowledge:([^#]+)(?:#|$)/.exec(item) : null;
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

interface Row {
  timestamp: number;
  agent_id: string | null;
  actor: string | null;
  action: string;
  details: string | null;
  gateway: string | null;
  chat_id: string | null;
}

/** `?, ?, …`, one per value. */
const marks = (values: readonly unknown[]) => values.map(() => "?").join(", ");

function toEntry(row: Row): AuditEntry & { timestamp: number } {
  return {
    action: row.action,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.actor ? { actor: row.actor } : {}),
    ...(row.gateway ? { gatewayId: row.gateway } : {}),
    ...(row.chat_id ? { chatId: row.chat_id } : {}),
    ...(row.details ? { details: JSON.parse(row.details) as Record<string, unknown> } : {}),
    timestamp: row.timestamp,
  };
}

/**
 * What the agent did, as the daemon depends on it.
 *
 * Business logic takes this, never `AuditLog` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type AuditPort = Port<AuditLog>;
