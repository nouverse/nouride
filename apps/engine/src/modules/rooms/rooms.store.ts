/**
 * Who is in a room, and what the room is called.
 *
 * Membership exists only where the daemon owns it. On Discord a room's members are the bots the
 * operator invited to that channel, and nothing in config says which channels a bot is in — recording
 * a guess there would be worse than recording nothing, because both readers would then narrow on a
 * list that disagrees with the platform. Behind a shared connection — the dashboard's — a person
 * picked the agents, and nothing else knows who they are. So a row here is **authoritative where it
 * exists and absent where it does not**.
 *
 * Without it, two things go wrong and neither shows as an error: the prompt's OTHER AGENTS section
 * names every enabled agent, so an agent tags one who is not in the room and nothing answers; and the
 * guard on untagged messages counts agents who are not there.
 *
 * The title is its own table rather than a column on every member row, because three rows can
 * disagree about what the room is called — and not on `sessions`, because a session is one agent's
 * side of the conversation. This is the only thing that reads or writes either table.
 *
 * ## The contract every caller depends on
 *
 * `membersOf` returns an **empty array for a room nobody has defined**, and that is not the same as
 * "a room with no agents in it". Both consumers — the prompt's OTHER AGENTS section and the
 * unaddressed-message guard — must read empty as "no opinion, carry on as before", because that is
 * every Discord and Telegram chat in existence. `hasMembers` is the predicate for asking the
 * question at all, and it exists so a caller cannot accidentally treat "undefined" as "nobody".
 */

import { createLogger, type Port} from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";

const log = createLogger("rooms");

export interface RoomMember {
  agentId: string;
  addedBy?: string;
  addedAt: number;
}

export interface Room {
  gatewayId: string;
  chatId: string;
  /** Absent when nobody named it — the client shows the member list instead. */
  title?: string;
  createdBy?: string;
  createdAt: number;
  members: RoomMember[];
}

export class RoomStore {
  constructor(private readonly db: SqliteDb) {}

  /**
   * Create the room, or leave an existing one alone.
   *
   * Idempotent on the room row so a client that retries a create does not lose the title it set the
   * first time, and so a room can gain members later without the caller having to know whether it
   * already exists.
   */
  create(input: {
    gatewayId: string;
    chatId: string;
    agentIds: string[];
    title?: string;
    createdBy?: string;
    at?: number;
  }): Room {
    const at = input.at ?? Date.now();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO chat_rooms (gateway_id, chat_id, title, created_by, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(gateway_id, chat_id) DO NOTHING`,
        )
        .run(input.gatewayId, input.chatId, input.title ?? null, input.createdBy ?? null, at);

      for (const agentId of input.agentIds) {
        this.db
          .prepare(
            `INSERT INTO chat_members (gateway_id, chat_id, agent_id, added_by, added_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(gateway_id, chat_id, agent_id) DO NOTHING`,
          )
          .run(input.gatewayId, input.chatId, agentId, input.createdBy ?? null, at);
      }
    });

    log.info("room created", {
      gateway_id: input.gatewayId,
      chat_id: input.chatId,
      members: input.agentIds.length,
    });
    return this.get(input.gatewayId, input.chatId)!;
  }

  /**
   * Add one agent. Returns false when it was already in.
   *
   * The boolean is what tells the caller whether to write a `joined` event: adding somebody twice is
   * not something that happened, and a room whose history says "Nero joined" three times is a
   * history nobody trusts.
   */
  add(input: {
    gatewayId: string;
    chatId: string;
    agentId: string;
    addedBy?: string;
    at?: number;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO chat_members (gateway_id, chat_id, agent_id, added_by, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(gateway_id, chat_id, agent_id) DO NOTHING`,
      )
      .run(
        input.gatewayId,
        input.chatId,
        input.agentId,
        input.addedBy ?? null,
        input.at ?? Date.now(),
      );
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Remove one agent. Returns false when it was not in.
   *
   * The agent's session for this chat is deliberately **not** touched. It holds the conversation it
   * had here, and deleting history because somebody was removed from a room is a destructive answer
   * to a question nobody asked — it stops receiving messages, which is what removing means.
   */
  remove(gatewayId: string, chatId: string, agentId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM chat_members WHERE gateway_id = ? AND chat_id = ? AND agent_id = ?")
      .run(gatewayId, chatId, agentId);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * The agents in this room, or an empty array when nobody has defined it.
   *
   * **Empty means "no opinion", not "nobody".** See the note at the top of this file: every platform
   * chat is undefined here, and a caller that reads empty as an empty room would silence every
   * Discord channel on the install.
   */
  membersOf(gatewayId: string, chatId: string): string[] {
    return this.db
      .prepare<{ agent_id: string }>(
        /**
         * `agent_id` breaks the tie, and it has to.
         *
         * Members created together share a millisecond, so `added_at` alone leaves SQLite free to
         * return them in any order — and it does, differently between reads. The list is drawn as a
         * row of avatars in a room header, so an unstable order is avatars swapping places between
         * renders for no reason a reader can see.
         */
        `SELECT agent_id FROM chat_members WHERE gateway_id = ? AND chat_id = ?
         ORDER BY added_at, agent_id`,
      )
      .all(gatewayId, chatId)
      .map((row) => row.agent_id);
  }

  /** Whether this chat has a membership list at all — the question to ask before narrowing on one. */
  hasMembers(gatewayId: string, chatId: string): boolean {
    const row = this.db
      .prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM chat_members WHERE gateway_id = ? AND chat_id = ?",
      )
      .get(gatewayId, chatId);
    return (row?.n ?? 0) > 0;
  }

  get(gatewayId: string, chatId: string): Room | null {
    const row = this.db
      .prepare<{ title: string | null; created_by: string | null; created_at: number }>(
        "SELECT title, created_by, created_at FROM chat_rooms WHERE gateway_id = ? AND chat_id = ?",
      )
      .get(gatewayId, chatId);
    if (!row) return null;

    const members = this.db
      .prepare<{ agent_id: string; added_by: string | null; added_at: number }>(
        // Same tie-break as `membersOf`, so the two never disagree about the order of a room.
        `SELECT agent_id, added_by, added_at FROM chat_members
         WHERE gateway_id = ? AND chat_id = ? ORDER BY added_at, agent_id`,
      )
      .all(gatewayId, chatId)
      .map((member) => ({
        agentId: member.agent_id,
        ...(member.added_by ? { addedBy: member.added_by } : {}),
        addedAt: member.added_at,
      }));

    return {
      gatewayId,
      chatId,
      ...(row.title ? { title: row.title } : {}),
      ...(row.created_by ? { createdBy: row.created_by } : {}),
      createdAt: row.created_at,
      members,
    };
  }

  /** Every room on a connection, most recently active first — the order the sidebar reads. */
  list(gatewayId: string): Room[] {
    return this.db
      .prepare<{ chat_id: string }>(
        "SELECT chat_id FROM chat_rooms WHERE gateway_id = ? ORDER BY created_at DESC",
      )
      .all(gatewayId)
      .map((row) => this.get(gatewayId, row.chat_id))
      .filter((room): room is Room => room !== null);
  }

  /** Rename it. `null` clears the name and the client falls back to the member list. */
  rename(gatewayId: string, chatId: string, title: string | null): boolean {
    const result = this.db
      .prepare("UPDATE chat_rooms SET title = ? WHERE gateway_id = ? AND chat_id = ?")
      .run(title, gatewayId, chatId);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * The room and its membership, gone.
   *
   * Called when the conversation is deleted. The sessions and their history are the caller's
   * business — this owns the room, not what was said in it.
   */
  delete(gatewayId: string, chatId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM chat_members WHERE gateway_id = ? AND chat_id = ?")
        .run(gatewayId, chatId);
      this.db
        .prepare("DELETE FROM chat_rooms WHERE gateway_id = ? AND chat_id = ?")
        .run(gatewayId, chatId);
    });
  }
}

/**
 * A room and its members, as the daemon depends on it.
 *
 * Business logic takes this, never `RoomStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type RoomsPort = Port<RoomStore>;
