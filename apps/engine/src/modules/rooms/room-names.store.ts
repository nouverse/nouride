/**
 * What a room is called (0.7.24) — the platform's name for it, and the operator's rename from the Groups page.
 *
 * Keyed by the room **as the platform sees it**, the platform and its chat id, like `room_mention`: several of our bots
 * sit in one group, one connection each, and the name is the group's. A dashboard room is not kept here — its title is
 * in `chat_rooms` (`rooms.store.ts`) — and `roomName` below is the one place that reads either.
 *
 * The platform's name is asked of the adapter (`Gateway.roomTitle`) as a group message arrives, only when there is none
 * yet or it is a day old, and never awaited by the message: a turn does not wait on a name. A rename here is the
 * operator's and wins over the platform's; cleared, the platform's is the name again.
 *
 * The memory vault's group files are storage, not names: `groups/<slug>.md` is where what is learned in a group is
 * kept, and renaming one names nothing.
 */

import { createLogger, type Gateway, type Port } from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";
import type { RoomsPort } from "./rooms.store.ts";

const log = createLogger("rooms.names");

/** How old the platform's name may be before it is asked again — a group is renamed rarely. */
const REFRESH_MS = 24 * 60 * 60_000;
/** After an ask that found nothing, how long until the next: a platform that cannot say should not be asked per message. */
const RETRY_MS = 60_000;
/** Rooms remembered as recently asked. */
const ASKED_CAP = 2_000;

export interface RoomNameRow {
  platform: string;
  chatId: string;
  /** What the platform calls it, when it said. */
  platformTitle?: string;
  /** The operator's rename, from the Groups page. */
  chosenTitle?: string;
  updatedAt: number;
}

export class RoomNameStore {
  /** Asks in flight or recently empty, by room: one at a time, and not again at once after nothing came back. */
  private readonly asked = new Map<string, number>();

  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
  ) {}

  get(platform: string, chatId: string): RoomNameRow | undefined {
    const row = this.db
      .prepare<{ platform_title: string | null; chosen_title: string | null; updated_at: number }>(
        "SELECT platform_title, chosen_title, updated_at FROM room_names WHERE platform = ? AND chat_id = ?",
      )
      .get(platform, chatId);
    return row ? toRow(platform, chatId, row) : undefined;
  }

  /** What the platform calls the room now. */
  setPlatformTitle(platform: string, chatId: string, title: string): void {
    this.db
      .prepare(
        `INSERT INTO room_names (platform, chat_id, platform_title, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(platform, chat_id) DO UPDATE SET platform_title = excluded.platform_title, updated_at = excluded.updated_at`,
      )
      .run(platform, chatId, title, this.now());
  }

  /** The operator's name for the room; empty or `null` clears it, and the platform's is the name again. */
  choose(platform: string, chatId: string, title: string | null): void {
    const chosen = title?.trim() || null;
    this.db
      .prepare(
        `INSERT INTO room_names (platform, chat_id, chosen_title, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(platform, chat_id) DO UPDATE SET chosen_title = excluded.chosen_title`,
      )
      .run(platform, chatId, chosen, this.now());
    log.info("a room was renamed", { platform, chat_id: chatId, cleared: chosen === null });
  }

  /**
   * Ask the platform for the room's name when there is none yet or it is a day old, and keep it. Never throws, and the
   * caller does not wait for it: a message is not held for a name.
   */
  async refresh(gateway: Pick<Gateway, "platform" | "roomTitle">, chatId: string): Promise<void> {
    if (!gateway.roomTitle) return;
    const key = `${gateway.platform}\u0000${chatId}`;
    const now = this.now();
    const known = this.get(gateway.platform, chatId);
    if (known?.platformTitle && now - known.updatedAt < REFRESH_MS) return;
    const last = this.asked.get(key);
    if (last !== undefined && now - last < RETRY_MS) return;
    // Bounded like every table in memory here: cleared wholesale past the cap, which costs one early ask per room.
    if (this.asked.size >= ASKED_CAP) this.asked.clear();
    this.asked.set(key, now);
    try {
      const title = (await gateway.roomTitle(chatId))?.trim();
      if (!title) return;
      this.setPlatformTitle(gateway.platform, chatId, title);
      this.asked.delete(key);
    } catch (err) {
      log.warn("could not ask a room's name", { platform: gateway.platform, chat_id: chatId, error: String(err) });
    }
  }
}

function toRow(platform: string, chatId: string, row: { platform_title: string | null; chosen_title: string | null; updated_at: number }): RoomNameRow {
  return {
    platform,
    chatId,
    ...(row.platform_title ? { platformTitle: row.platform_title } : {}),
    ...(row.chosen_title ? { chosenTitle: row.chosen_title } : {}),
    updatedAt: row.updated_at,
  };
}

/** A room's names, as the daemon depends on them — see `Port` in `@nouride/shared`. */
export type RoomNamePort = Port<RoomNameStore>;

/**
 * **The** name of a room — the one place it is read. A dashboard room's own title; otherwise the operator's rename,
 * then the platform's. `undefined` when nobody and nothing named it: a one-to-one, or a group whose platform has not
 * said yet.
 */
export function roomName(
  sources: { rooms?: Pick<RoomsPort, "get"> | undefined; roomNames?: Pick<RoomNamePort, "get"> | undefined },
  room: { gatewayId: string; platform: string; chatId: string },
): string | undefined {
  const local = sources.rooms?.get(room.gatewayId, room.chatId);
  if (local) return local.title;
  const named = sources.roomNames?.get(room.platform, room.chatId);
  return named?.chosenTitle ?? named?.platformTitle;
}
