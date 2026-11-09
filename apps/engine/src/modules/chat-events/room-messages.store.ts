/**
 * What people said in a room — read, written, and swept.
 *
 * A room's transcript used to be assembled from `turn_records`, and a turn record exists only when an
 * agent *runs* — so a message that addressed nobody vanished from the transcript. In a group chat every
 * message is part of the conversation; being answered is a separate question. So a person's message is
 * recorded here the moment the daemon accepts it, before routing has decided anything.
 *
 * Not a turn record for the same reason `chat_events` is not: a message nobody answered has no agent
 * and no session. It also fixes the mirror-image bug, a message answered by two agents drawn twice —
 * turns carry `message_id`, so a reply attaches to the message rather than restating it. A message is
 * its connection, its chat and its id together: a platform numbers messages per chat, so an id alone
 * names one line in every group (`080_chat_messages_key.sql`).
 *
 * Only what people say. Agent replies are turns, with their steps and timings, and a second record of
 * one reply could disagree with the first; an agent's own message echoed back inbound is filtered on
 * `sender_is_bot` at the write site for the same reason. This is the only thing that touches the table.
 *
 * It lives beside `ChatEventStore` because the two answer the same shape of question — what belongs
 * to the *room* rather than to one agent's conversation — and a reader assembling a room's transcript
 * needs both.
 */

import { createLogger, type Port} from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";

const log = createLogger("chat-messages");

export interface RoomMessageAttachment {
  name: string;
  mimeType: string;
  kind: string;
}

export interface RoomMessage {
  id: string;
  gatewayId: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  text: string;
  attachments?: RoomMessageAttachment[];
  at: number;
}

interface Row {
  id: string;
  gateway_id: string;
  chat_id: string;
  sender_id: string;
  sender_name: string | null;
  text: string;
  attachments: string | null;
  at: number;
}

export class RoomMessageStore {
  constructor(private readonly db: SqliteDb) {}

  /**
   * Record one, or leave the existing row alone.
   *
   * Each connection keeps its own copy: on a platform that hands every bot its own copy of a message,
   * this is reached once per connection, and each agent's log is what its own bot heard. Keyed by the
   * id alone, the first bot's copy was kept and the rest dropped, and so was a second group's message
   * of the same number. What the conflict still turns away is one connection handed a message again.
   */
  record(input: {
    id: string;
    gatewayId: string;
    chatId: string;
    senderId: string;
    senderName?: string;
    text: string;
    attachments?: RoomMessageAttachment[];
    at?: number;
  }): void {
    // An empty message with no files is not something somebody said. A bare tag arrives that way and
    // the *turn* records what the harness made of it; a blank bubble would say nothing.
    if (!input.text.trim() && !input.attachments?.length) return;

    try {
      this.db
        .prepare(
          `INSERT INTO chat_messages (id, gateway_id, chat_id, sender_id, sender_name, text,
                                      attachments, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(gateway_id, chat_id, id) DO NOTHING`,
        )
        .run(
          input.id,
          input.gatewayId,
          input.chatId,
          input.senderId,
          input.senderName ?? null,
          input.text,
          input.attachments?.length ? JSON.stringify(input.attachments) : null,
          input.at ?? Date.now(),
        );
    } catch (err) {
      // A transcript row is not worth failing a turn over: the message is already being routed, and
      // losing its bubble is better than losing the answer.
      log.warn("could not record a room message", {
        chat_id: input.chatId,
        error: String(err),
      });
    }
  }

  /**
   * A message somebody edited: the room's record says what it says now. Nothing when it was never recorded, and
   * nothing for an edit that leaves no words — a blank bubble says nothing.
   */
  revise(gatewayId: string, chatId: string, id: string, text: string): void {
    if (!text.trim()) return;
    try {
      this.db.prepare("UPDATE chat_messages SET text = ? WHERE id = ? AND gateway_id = ? AND chat_id = ?").run(text, id, gatewayId, chatId);
    } catch (err) {
      log.warn("could not record an edit of a room message", { chat_id: chatId, error: String(err) });
    }
  }

  /** One room's messages, oldest first. */
  forChat(gatewayId: string, chatId: string, limit = 400): RoomMessage[] {
    return this.db
      .prepare<Row>(
        `SELECT * FROM chat_messages WHERE gateway_id = ? AND chat_id = ?
         ORDER BY at DESC LIMIT ?`,
      )
      .all(gatewayId, chatId, limit)
      .reverse()
      .map(toMessage);
  }

  /** One room's messages in a window, oldest first — the people's half of a group episode. */
  between(gatewayId: string, chatId: string, after: number, until: number): RoomMessage[] {
    return this.db
      .prepare<Row>("SELECT * FROM chat_messages WHERE gateway_id = ? AND chat_id = ? AND at > ? AND at <= ? ORDER BY at")
      .all(gatewayId, chatId, after, until)
      .map(toMessage);
  }

  /** Whether anything was ever recorded here — which only happens in a group, never a DM. */
  isRoom(gatewayId: string, chatId: string): boolean {
    return this.db.prepare<{ one: number }>("SELECT 1 AS one FROM chat_messages WHERE gateway_id = ? AND chat_id = ? LIMIT 1").get(gatewayId, chatId) !== null;
  }

  /**
   * The name somebody last wrote under on this connection, if they have written in a room it reads.
   *
   * For an account let in ahead (`nouride access allow`) — an id from config.toml carries no name, and
   * the room log has usually seen theirs. Newest first by `idx_chat_messages_at`, stopping at the first.
   */
  lastNameOf(gatewayId: string, senderId: string): string | null {
    return (
      this.db
        .prepare<{ sender_name: string }>(
          "SELECT sender_name FROM chat_messages WHERE gateway_id = ? AND sender_id = ? AND sender_name IS NOT NULL ORDER BY at DESC LIMIT 1",
        )
        .get(gatewayId, senderId)?.sender_name ?? null
    );
  }

  /**
   * Bounded by the conversation retention window, like the turns and the events.
   *
   * One knob for the three, because they are one transcript seen from three angles — see the note in
   * `ChatEventStore.sweep`.
   */
  sweep(retentionDays: number, now: number = Date.now()): number {
    if (retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * 24 * 60 * 60_000;
    const result = this.db.prepare("DELETE FROM chat_messages WHERE at < ?").run(cutoff);
    return Number(result.changes ?? 0);
  }

  /** Dropped with the conversation, so a deleted room leaves nothing behind. */
  deleteForChat(gatewayId: string, chatId: string): number {
    const result = this.db
      .prepare("DELETE FROM chat_messages WHERE gateway_id = ? AND chat_id = ?")
      .run(gatewayId, chatId);
    return Number(result.changes ?? 0);
  }
}

function toMessage(row: Row): RoomMessage {
  return {
    id: row.id,
    gatewayId: row.gateway_id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    ...(row.sender_name ? { senderName: row.sender_name } : {}),
    text: row.text,
    ...(row.attachments ? { attachments: parseAttachments(row.attachments) } : {}),
    at: row.at,
  };
}

/** A malformed blob costs one bubble its paperclip, not the whole transcript. */
function parseAttachments(raw: string): RoomMessageAttachment[] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as RoomMessageAttachment[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What people said in a room, as the daemon depends on it.
 *
 * Business logic takes this, never `RoomMessageStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type RoomMessagesPort = Port<RoomMessageStore>;
