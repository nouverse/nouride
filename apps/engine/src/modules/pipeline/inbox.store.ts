/**
 * The inbox.
 *
 * A message from a platform, written down after admission and before anything acts on it. Before this,
 * the queue and the media batcher were memory and a DM was written nowhere until its turn began, so a
 * restart lost whatever was waiting — and Telegram's backlog from the downtime was thrown away on purpose,
 * because nothing could tell a fresh message from yesterday's.
 *
 * Keyed by the platform's own message id within its chat, so a second arrival is recognised: a process that
 * dies before confirming a Telegram update gets that update again, and must not answer it twice.
 *
 * - `queued` — received, waiting for a turn;
 * - `placed` — a turn has taken it;
 * - `done` — handled (answered, refused with a notice, or closed with its work kept);
 * - `unanswered` — nothing will answer it, and `reason` says why: `stale` (sent too long ago — the person
 *   is told), `dropped` (the queue overflowed or timed out), `interrupted` (its turn died with the process).
 *
 * At boot what is still `queued` is put back in the queue when fresh, or answered with a notice when
 * stale. Settled rows go after two days.
 */

import { createLogger, type MessageEnvelope, type Port } from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";

const log = createLogger("inbox");

/** How recently a message must have been sent to still be answered — by the platform's own clock. */
export const INBOX_FRESH_MS = 15 * 60_000;
/** How long a settled row is kept: long enough to recognise a redelivery, short enough to stay small. */
export const INBOX_KEEP_MS = 2 * 86_400_000;

export type UnansweredReason = "stale" | "dropped" | "interrupted";

export interface InboxRow {
  id: string;
  gatewayId: string;
  chatId: string;
  receivedAt: number;
  sentAt: number;
  status: "queued" | "placed";
  envelope: MessageEnvelope;
}

interface Row {
  id: string;
  gateway_id: string;
  chat_id: string;
  received_at: number;
  sent_at: number;
  status: "queued" | "placed";
  envelope: string;
}

/** The inbox id of a message — and of every message a burst folded into it. */
export function inboxIds(envelope: MessageEnvelope): string[] {
  return [envelope.id, ...(envelope.mergedIds ?? [])].map((id) => inboxId(envelope.gatewayId, envelope.chatId, id));
}

/** The inbox id of one message: its platform id within its chat, on its connection. */
export function inboxId(gatewayId: string, chatId: string, messageId: string): string {
  return `${gatewayId}:${chatId}:${messageId}`;
}

/** When the platform says it was sent — the time a message is judged fresh by. A missing one is now. */
export function sentAt(envelope: MessageEnvelope, now: number): number {
  return envelope.timestamp > 0 ? envelope.timestamp : now;
}

export class InboxStore {
  constructor(private readonly db: SqliteDb) {}

  /** Write a message down. False when it was already here — a redelivery, which is not answered again. */
  receive(envelope: MessageEnvelope, now: number = Date.now()): boolean {
    const [id] = inboxIds({ ...envelope, mergedIds: [] });
    const result = this.db
      .prepare(
        `INSERT INTO inbox (id, gateway_id, chat_id, received_at, sent_at, status, envelope)
         VALUES (?, ?, ?, ?, ?, 'queued', ?) ON CONFLICT(id) DO NOTHING`,
      )
      // Without `raw`: the platform's own object, which nothing downstream reads and which for some
      // clients does not survive JSON at all.
      .run(id, envelope.gatewayId, envelope.chatId, now, sentAt(envelope, now), JSON.stringify({ ...envelope, raw: null }));
    return result.changes > 0;
  }

  /**
   * A message as it was written down — what it said and when it was sent — whatever became of it since; null when it
   * was never received or has been swept. What an edit of it is measured against (G11).
   */
  find(id: string): { envelope: MessageEnvelope; sentAt: number } | null {
    const row = this.db.prepare<Pick<Row, "envelope" | "sent_at">>("SELECT envelope, sent_at FROM inbox WHERE id = ?").get(id);
    if (!row) return null;
    try {
      return { envelope: JSON.parse(row.envelope) as MessageEnvelope, sentAt: row.sent_at };
    } catch {
      return null;
    }
  }

  /** A message still waiting, edited before a turn took it: the corrected one is what a restart answers (G11). */
  revise(envelope: MessageEnvelope): void {
    const id = inboxId(envelope.gatewayId, envelope.chatId, envelope.id);
    this.write(() => this.db.prepare("UPDATE inbox SET envelope = ? WHERE id = ? AND status = 'queued'").run(JSON.stringify({ ...envelope, raw: null }), id), 1);
  }

  /** A turn has taken these messages. */
  placed(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.write(() => this.db.prepare(`UPDATE inbox SET status = 'placed' WHERE id IN (${marks(ids)}) AND status = 'queued'`).run(...ids), ids.length);
  }

  /**
   * Not taken after all: handed to a turn already running, to read at its next step (a room's steering). Back
   * to waiting, so a restart before that step answers it rather than counting it among the work that died.
   */
  unplaced(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.write(() => this.db.prepare(`UPDATE inbox SET status = 'queued' WHERE id IN (${marks(ids)}) AND status = 'placed'`).run(...ids), ids.length);
  }

  /** Handled — or, with a reason, never to be answered. */
  settle(ids: readonly string[], status: "done" | "unanswered", reason?: UnansweredReason, now: number = Date.now()): void {
    if (ids.length === 0) return;
    this.write(
      () =>
        this.db
          .prepare(`UPDATE inbox SET status = ?, reason = ?, settled_at = ? WHERE id IN (${marks(ids)}) AND settled_at IS NULL`)
          .run(status, reason ?? null, now, ...ids),
      ids.length,
    );
  }

  /** Every message received before `receivedBefore` and not yet settled, oldest first — read once, at boot. */
  open(receivedBefore: number = Date.now()): InboxRow[] {
    const rows = this.db
      .prepare<Row>(
        "SELECT id, gateway_id, chat_id, received_at, sent_at, status, envelope FROM inbox WHERE status IN ('queued', 'placed') AND received_at < ? ORDER BY status, received_at",
      )
      .all(receivedBefore);
    const out: InboxRow[] = [];
    for (const row of rows) {
      try {
        out.push({
          id: row.id,
          gatewayId: row.gateway_id,
          chatId: row.chat_id,
          receivedAt: row.received_at,
          sentAt: row.sent_at,
          status: row.status,
          envelope: JSON.parse(row.envelope) as MessageEnvelope,
        });
      } catch (err) {
        log.warn("an inbox row could not be read, so it is settled as dropped", { id: row.id, error: String(err) });
        this.settle([row.id], "unanswered", "dropped");
      }
    }
    return out;
  }

  /** Delete what was settled before `before`. */
  sweep(before: number): number {
    return this.db.prepare("DELETE FROM inbox WHERE settled_at IS NOT NULL AND settled_at < ?").run(before).changes;
  }

  /** Rows still open — `nouride doctor`. */
  openCount(): number {
    return this.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE status IN ('queued', 'placed')").get()?.n ?? 0;
  }

  /** A status change that fails is logged, never thrown: the message it describes is being handled regardless. */
  private write(statement: () => unknown, ids: number): void {
    try {
      statement();
    } catch (err) {
      log.warn("could not update the inbox", { ids, error: String(err) });
    }
  }
}

/** One placeholder per id — a burst is a handful, one statement. */
function marks(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export type InboxPort = Port<InboxStore>;
