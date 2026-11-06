/**
 * Whether a conversation is a room or a one-to-one, remembered per chat.
 *
 * Every turn a *person* starts carries the answer on its envelope, because the platform said so. The
 * turns nobody starts do not: a finished background job, a late approval and a cron dispatch all
 * build a synthetic envelope out of a `(gateway, chat)` pair, and that pair is all the job row holds.
 * All four sites wrote `chatType: "dm"` and moved on.
 *
 * That constant was load-bearing in the wrong direction, and it is what this exists to end. Since the
 * DM handover became a bus, `chatType` decides *how an agent is told it can reach another agent* — so
 * a job completing in a Discord channel produced a turn whose prompt said "this is a one-to-one chat,
 * writing @their-name does nothing". In a room where every bot sees every message and the tag is the
 * whole mechanism. The closing hop of a handover is exactly the thing a background job interrupts, and
 * it was being told the tag it needed was inert.
 *
 * ## Why a table and not a column
 *
 * A `chat_type` on `jobs` would answer for jobs and not for the other three, and each of them would
 * need its own. The fact belongs to the *chat*, not to the thing that happens to be waking it.
 *
 * In memory and bounded, like the outbound registry and the claim table. It is a cache of something
 * the platform will say again on the next message — and `of()` returning nothing is a documented
 * answer the callers handle, not a hole. What it does not hold, the room log may: a chat with a line
 * recorded there is a room, since only rooms are recorded. Without that, every synthetic turn into a
 * room between a restart and the next message there was built as a one-to-one — a scheduled turn's
 * tag of another agent's bot was posted and never handed over (0.8.12, live in the owner's group).
 */

import { createLogger, type ChatType, type MessageEnvelope } from "@nouride/shared";
import { isSystemEvent } from "./deps.ts";

const log = createLogger("pipeline.chat-types");

/**
 * Chats remembered.
 *
 * One short string per conversation the daemon has seen, so this is small — but "small" over months
 * of uptime with a public bot is still unbounded, which is the mistake every other table in this
 * directory has made once.
 */
const CAP = 5_000;
/** Dropped in one go when the cap is hit, oldest first. */
const EVICT = 500;

export class ChatTypes {
  private readonly known = new Map<string, ChatType>();

  /** `recorded`: whether the room log holds this chat — on disk, so it answers after a restart. */
  constructor(private readonly recorded?: (gatewayId: string, chatId: string) => boolean) {}

  /**
   * Record what the platform said about this chat.
   *
   * Called for every inbound message, before anything decides whether to answer it — an unadmitted
   * stranger's message still tells us truthfully what kind of room they said it in.
   */
  remember(envelope: MessageEnvelope): void {
    // A synthetic envelope's own guess must never become the remembered answer: that is how one wrong
    // default outlives the message that caused it and starts teaching itself.
    if (isSystemEvent(envelope)) return;

    const key = keyFor(envelope.gatewayId, envelope.chatId);
    if (this.known.get(key) === envelope.chatType) return;
    this.known.set(key, envelope.chatType);

    if (this.known.size > CAP) {
      // Insertion order, so the first keys out are the least recently *first seen*. Good enough for a
      // cache whose miss costs one prompt sentence, and it needs no second structure to maintain.
      for (const staleKey of [...this.known.keys()].slice(0, EVICT)) this.known.delete(staleKey);
      log.debug("chat-type cache trimmed", { remaining: this.known.size });
    }
  }

  /**
   * What kind of chat this is: what its last message said, else a room if the room log holds it, else
   * nothing.
   *
   * Deliberately not defaulted here. The callers are building synthetic envelopes and each has to
   * state its own fallback next to the code that depends on it — see `wakeForJob`.
   */
  of(gatewayId: string, chatId: string): ChatType | undefined {
    return this.known.get(keyFor(gatewayId, chatId)) ?? (this.recorded?.(gatewayId, chatId) ? "group" : undefined);
  }

  /** Table size, so a test can catch it growing without bound. */
  size(): number {
    return this.known.size;
  }
}

function keyFor(gatewayId: string, chatId: string): string {
  // The instance, not the platform: the same chat id on two connections is two conversations, and one
  // of them can be a DM while the other is not.
  return `${gatewayId}:${chatId}`;
}
