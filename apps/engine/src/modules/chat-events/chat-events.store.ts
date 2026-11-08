/**
 * Things that happened *to* a conversation — read, written, and swept.
 *
 * WhatsApp draws these in the middle of a thread — "Gading added Nero", "you changed the group name". A room needs
 * them for the same reason: most of what changes about a group is not something anybody typed, and rendering it as
 * somebody's message is a lie about who said it.
 *
 * ## Why not `turn_records`
 *
 * That table was the obvious home and it refuses the shape: `agent_id`, `session_id` and `prompt` are NOT NULL, and
 * a room-wide notice has none of the three — nobody was asked anything, no agent owns it, and there is no session
 * because a session is one *agent's* side of a conversation. Loosening those columns would make every reader of a
 * turn filter out rows that are not turns, and lose the guarantee that a real turn is readable without a null check.
 *
 * ## Scope
 *
 * Keyed on `(gateway_id, chat_id)` — the **room**, not a session. "Nero joined" is one fact about one chat; written
 * into one agent's session, the other agents in the room would never learn it.
 *
 * The audience split (`EventAudience` below) is the point of the table rather than a convenience: without it the only
 * two options for anything the daemon wants to say are "put it in the model's context" and "throw it away", and most
 * of these belong in neither. The column comments in `069_baseline.sql` predate three squashes and stay as they are — an
 * applied migration is never edited — so its "see above" on the audience means `EventAudience`, and its list of kinds
 * predates `delegated`: `ChatEventKind` is the list.
 *
 * This file is the only thing that writes the table, and the guard below is why that matters.
 */

import { createLogger, newId, type Port} from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";
import type { ChatEventKind } from "@nouride/wire";

const log = createLogger("chat-events");

/**
 * Whether the model sees it.
 *
 * Every event is shown in the dashboard either way. `"agents"` additionally composes the text into
 * the next prompt of each agent in the room; `"ui"` never enters a prompt under any circumstances.
 */
export type EventAudience = "agents" | "ui";

export interface ChatEvent {
  id: string;
  gatewayId: string;
  chatId: string;
  audience: EventAudience;
  kind: ChatEventKind;
  text: string;
  agentId?: string;
  actor?: string;
  details?: Record<string, unknown>;
  at: number;
}

export interface RecordEvent {
  gatewayId: string;
  chatId: string;
  audience: EventAudience;
  kind: ChatEventKind;
  text: string;
  /** The agent this is *about*, when it is about one. Omitted means room-wide. */
  agentId?: string;
  actor?: string;
  details?: Record<string, unknown>;
  /**
   * Who is writing.
   *
   * Defaults to the daemon. See `record` for why an agent may not write an `"agents"` event.
   */
  origin?: "daemon" | "agent";
  at?: number;
}

interface Row {
  id: string;
  gateway_id: string;
  chat_id: string;
  audience: string;
  kind: string;
  text: string;
  agent_id: string | null;
  actor: string | null;
  details: string | null;
  at: number;
}

/** How many unseen `agents` events a prompt will carry. See `since`. */
export const MAX_REPLAYED_EVENTS = 10;

export class ChatEventStore {
  constructor(private readonly db: SqliteDb) {}

  /**
   * Write one.
   *
   * **An agent may not write an `"agents"` event, and that refusal is here rather than in whatever
   * tool eventually exposes this.**
   *
   * The reason is the rule the whole room design rests on: one agent reaches another *only* by
   * `@mention`, which costs a hop, is counted against `mention_max_hops`, and stops. An `"agents"`
   * event is text placed into every other agent's next prompt with no mention, no hop, and no
   * ceiling — and read in the daemon's voice rather than a peer's, which is a stronger voice. The
   * repo already has the recorded failure for the weaker version of this: an unlabelled room block
   * made the model answer the chatter instead of the person who tagged it (`group-context.ts`).
   *
   * So an agent gets `"ui"`: it can annotate the room for the person reading, and the only way it
   * influences another agent's context stays the path that has a budget and an audit trail.
   *
   * Placed at the boundary because the alternative is a rule every future caller has to remember,
   * and the callers that will exist are tools written to be convenient.
   */
  record(input: RecordEvent): ChatEvent | null {
    if (input.origin === "agent" && input.audience === "agents") {
      log.warn("refused an agent-authored event addressed to agents", {
        gateway_id: input.gatewayId,
        chat_id: input.chatId,
        kind: input.kind,
      });
      return null;
    }

    const event: ChatEvent = {
      id: newId("evt"),
      gatewayId: input.gatewayId,
      chatId: input.chatId,
      audience: input.audience,
      kind: input.kind,
      text: input.text,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.details ? { details: input.details } : {}),
      at: input.at ?? Date.now(),
    };

    this.db
      .prepare(
        `INSERT INTO chat_events (id, gateway_id, chat_id, audience, kind, text, agent_id, actor,
                                  details, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.gatewayId,
        event.chatId,
        event.audience,
        event.kind,
        event.text,
        event.agentId ?? null,
        event.actor ?? null,
        event.details ? JSON.stringify(event.details) : null,
        event.at,
      );

    return event;
  }

  /**
   * The `agents` events this agent has not been shown yet, oldest first.
   *
   * The window is the same one the room's overheard block uses — everything since the agent was last
   * spoken to — and for the same reason. The block is composed into the user message and *stored with
   * it*, so an event is replayed exactly once: it becomes part of that agent's conversation like
   * anything else, and the next window starts after the message that carried it.
   *
   * `before` excludes anything newer than the message being answered, so an event written while this
   * turn was being set up does not arrive as though it had already happened.
   *
   * Inclusive at that end, unlike the overheard window, and the difference is not an oversight.
   * `GroupContext.since` has to be strict because the triggering message is *itself* in the buffer it
   * reads, so `<= before` would replay the question as its own context. No event is ever the message
   * being answered, so there is nothing to exclude at the boundary — and a strict comparison would
   * instead drop an event that happened to land in the same millisecond as the message, silently and
   * for no gain. Replay is still bounded on the other side: the next window starts at the timestamp
   * of the message that carried the block, and `at > after` excludes anything already shown.
   *
   * `"ui"` rows cannot come back from here. The filter is in the SQL rather than applied by the
   * caller, because a caller that forgets is a caller that puts UI chrome into a prompt, and nothing
   * downstream could tell.
   */
  since(query: {
    gatewayId: string;
    chatId: string;
    after: number;
    before: number;
    limit?: number;
  }): ChatEvent[] {
    const limit = query.limit ?? MAX_REPLAYED_EVENTS;
    if (limit <= 0) return [];

    return this.db
      .prepare<Row>(
        `SELECT * FROM chat_events
         WHERE gateway_id = ? AND chat_id = ? AND audience = 'agents' AND at > ? AND at <= ?
         ORDER BY at DESC LIMIT ?`,
      )
      .all(query.gatewayId, query.chatId, query.after, query.before, limit)
      .reverse()
      .map(toEvent);
  }

  /**
   * Everything in one room, newest first — both audiences, for the dashboard.
   *
   * Newest first because that is the page a transcript opens on, and the client interleaves these
   * with the turns from `TurnStore.forChat` by timestamp.
   */
  forChat(gatewayId: string, chatId: string, limit = 200): ChatEvent[] {
    return this.db
      .prepare<Row>(
        `SELECT * FROM chat_events WHERE gateway_id = ? AND chat_id = ?
         ORDER BY at DESC LIMIT ?`,
      )
      .all(gatewayId, chatId, limit)
      .map(toEvent);
  }

  /**
   * Bounded by the conversation retention window, not one of its own.
   *
   * An event annotates a conversation, so outliving the conversation it annotates would leave a
   * transcript of nothing but system notices. Sharing `[retention] session_days` also means one
   * fewer knob for an operator to discover, which matters more than the precision a separate one
   * would buy.
   */
  sweep(retentionDays: number, now: number = Date.now()): number {
    if (retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * 24 * 60 * 60_000;
    const result = this.db.prepare("DELETE FROM chat_events WHERE at < ?").run(cutoff);
    return Number(result.changes ?? 0);
  }

  /** Dropped with the conversation, so `/new` does not leave a room's notices behind it. */
  deleteForChat(gatewayId: string, chatId: string): number {
    const result = this.db
      .prepare("DELETE FROM chat_events WHERE gateway_id = ? AND chat_id = ?")
      .run(gatewayId, chatId);
    return Number(result.changes ?? 0);
  }
}

function toEvent(row: Row): ChatEvent {
  return {
    id: row.id,
    gatewayId: row.gateway_id,
    chatId: row.chat_id,
    audience: row.audience as EventAudience,
    kind: row.kind as ChatEventKind,
    text: row.text,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.actor ? { actor: row.actor } : {}),
    ...(row.details ? { details: safeParse(row.details) } : {}),
    at: row.at,
  };
}

/**
 * A row whose JSON will not parse is not worth failing a transcript over.
 *
 * `details` is decoration — the sentence is in `text` — so a malformed blob costs a client one
 * missing field, while throwing here would empty the whole page.
 */
function safeParse(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Things that happened to a room, as the daemon depends on it.
 *
 * Business logic takes this, never `ChatEventStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type ChatEventsPort = Port<ChatEventStore>;
