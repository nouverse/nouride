/**
 * A group's own answer to `groups_require_mention` — set from the group with `/mention` (`hooks/builtins/mention.ts`).
 *
 * Keyed by the room **as the platform sees it**: the platform (`telegram`) and its chat id, never our connection.
 * Several of our bots sit in one group, one connection each, and every one of them is handed the same message; the
 * setting is the group's, so one row answers for all of them. Keyed by connection, `/mention off` would have changed
 * it for the bot that happened to take the command and left the others asking for a tag.
 *
 * A row is an override; no row is no opinion, and the connection's setting and then the daemon's decide as they did
 * before this table existed (`requireMentionHere` in `room-mention.ts`). `clear` is how a group goes back to that.
 *
 * In SQLite, not memory: "this group does not need a mention" is said once and meant until someone says otherwise —
 * a restart is not someone saying otherwise.
 */

import { createLogger, type Port } from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";

const log = createLogger("pipeline.room-mention");

/** What a group said, and who said it. */
export interface RoomMentionSetting {
  requireMention: boolean;
  setBy: string;
  setAt: number;
}

export class RoomMentionStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** This group's override, or nothing when it has none. Read on every group message: a primary-key lookup. */
  get(platform: string, chatId: string): RoomMentionSetting | undefined {
    const row = this.db
      .prepare<{ require_mention: number; set_by: string; set_at: number }>(
        "SELECT require_mention, set_by, set_at FROM room_mention WHERE platform = ? AND chat_id = ?",
      )
      .get(platform, chatId);
    return row ? { requireMention: row.require_mention === 1, setBy: row.set_by, setAt: row.set_at } : undefined;
  }

  /** Set this group's override, replacing one it had. */
  set(platform: string, chatId: string, requireMention: boolean, setBy: string): void {
    this.db
      .prepare(
        `INSERT INTO room_mention (platform, chat_id, require_mention, set_by, set_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(platform, chat_id) DO UPDATE SET
           require_mention = excluded.require_mention, set_by = excluded.set_by, set_at = excluded.set_at`,
      )
      .run(platform, chatId, requireMention ? 1 : 0, setBy, this.now());
    log.info("a group's mention setting changed", { platform, chat_id: chatId, require_mention: requireMention, by: setBy });
  }

  /** Remove the override, so the connection and the daemon decide again. False when there was none. */
  clear(platform: string, chatId: string): boolean {
    const result = this.db.prepare("DELETE FROM room_mention WHERE platform = ? AND chat_id = ?").run(platform, chatId);
    const removed = Number(result.changes ?? 0) > 0;
    if (removed) log.info("a group's mention setting cleared", { platform, chat_id: chatId });
    return removed;
  }
}

/** A group's mention setting, as the daemon depends on it — see `Port` in `@nouride/shared`. */
export type RoomMentionPort = Port<RoomMentionStore>;
