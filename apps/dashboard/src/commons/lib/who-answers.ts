/**
 * Who answers a message that tags nobody in one room, as a picker's values have it: the room's own setting, the one
 * `/mention` writes from the chat. Picked on the Groups page and in the header of a room made in the dashboard, by one
 * set of values and in the same words, so neither says something the other does not.
 */

import type { GroupRecord } from "@nouride/wire";

export const DEFAULT = "default";
export const REQUIRED = "required";
const AGENT = "agent:";

/** The value that picks one agent. */
export const agentChoice = (agentId: string): string => `${AGENT}${agentId}`;

/** What is picked now, as the list's values have it: an agent picked that is gone reads as nobody, by its absence. */
export function pickedOf(room: Pick<GroupRecord, "mention" | "untagged">): string {
  if (!room.mention) return DEFAULT;
  if (room.mention.requireTag) return REQUIRED;
  return agentChoice(room.mention.answerer ?? room.untagged ?? "");
}

/** What the daemon is sent for a choice. */
export function choiceSent(next: string): { mention: "required" | "default" } | { mention: "agent"; agent: string } {
  return next.startsWith(AGENT) ? { mention: "agent", agent: next.slice(AGENT.length) } : { mention: next as "default" | "required" };
}

/** What a choice did once saved, as its toast says it. */
export function choiceSaid(next: string, room: string, nameOf: (agentId: string) => string): string {
  if (next === REQUIRED) return `A tag is needed in ${room}`;
  if (next === DEFAULT) return `${room} follows the default again`;
  return `${nameOf(next.slice(AGENT.length))} answers in ${room} when nobody is tagged`;
}
