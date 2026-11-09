/**
 * How many of the queue's slots one conversation may hold at once.
 *
 * A one-to-one chat holds `max_concurrent_per_agent`: its turns write one conversation, and two at once interleave it.
 * A room's conversations are per agent, so a room runs several turns at once — and it used to be allowed all of them:
 * its cap was the ceiling itself, so one busy room could take every slot `max_concurrent_turns` has, and every other
 * chat on the daemon waited behind it with nothing of its own running. Fairness between keys was arrival time alone.
 *
 * Now a room holds at most half the ceiling, and no more than its agents can use. That is its agents plus one, not its
 * agents: a slot runs a message, and in a room a message for an agent already at work there is not a turn — it is read
 * by that turn as a steer, or answered with "still working" (`steer-accept.ts`), in a moment. A cap of exactly the
 * agents held that message back until the turn it was meant for had ended, so a room with one agent could never be
 * steered at all. The agents bound the room's turns by themselves: an agent never runs two in one room.
 *
 * More than that buys nothing, and more than half the ceiling leaves the rest of the daemon a share smaller than one
 * room's. With no ceiling (`0`), only the agents bound it.
 */

import type { MessageEnvelope } from "@nouride/shared";
import type { PipelineDeps } from "./deps.ts";

/** The per-key cap the queue reads, for the message at the head of a conversation's line. */
export function conversationSlots(
  envelope: Pick<MessageEnvelope, "chatType" | "gatewayId" | "chatId">,
  deps: Pick<PipelineDeps, "config" | "rooms" | "registry">,
): number {
  const { maxConcurrentPerAgent, maxConcurrentTurns } = deps.config.queue;
  if (envelope.chatType === "dm") return maxConcurrentPerAgent;
  return roomSlots(roomMembers(envelope, deps), maxConcurrentTurns);
}

/**
 * `min(members + 1, ceil(ceiling / 2))`, and at least one — a room that could hold no slot would never be answered.
 * The one is the message on its way to an agent already working there.
 */
export function roomSlots(members: number, ceiling: number): number {
  const half = ceiling > 0 ? Math.ceil(ceiling / 2) : Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(members + 1, half));
}

/**
 * The agents in a room: its membership where the daemon keeps one (a dashboard room), else every enabled agent — a
 * Discord channel or a Telegram group has no list, and any agent could be addressed there (`rooms.store.ts`).
 */
function roomMembers(envelope: Pick<MessageEnvelope, "gatewayId" | "chatId">, deps: Pick<PipelineDeps, "rooms" | "registry">): number {
  return deps.rooms?.membersOf(envelope.gatewayId, envelope.chatId).length || deps.registry.enabled().length;
}
