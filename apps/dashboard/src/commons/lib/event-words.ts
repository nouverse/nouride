/**
 * What happened to a room, in the dashboard's words. The daemon writes each event as a sentence for the agents — "cli
 * started this room with nouva, nestor, nix." — with agent ids and an account's login in it. The person reading gets the
 * agents' names joined as a person writes them, "You" for themselves, and for the server itself (the control token,
 * which is nobody by name) the sentence without a who: "This room was started with Nouva, Nestor and Nix."
 *
 * Said from the event's data; an event without the data it needs keeps the daemon's sentence.
 *
 * Pure.
 */

import type { ChatEvent } from "@nouride/wire";
import { listed } from "@/commons/lib/listed";

/** The control token's actor, as the rest of the dashboard reads it: the server itself, not a person. */
const SERVER_ITSELF = "cli";

export interface EventNames {
  /** The account reading, by the login an event names its actor by. */
  viewer: string | undefined;
  /** An agent's name, by its id. */
  nameOf: (agentId: string) => string;
}

export function eventWords(event: ChatEvent, names: EventNames): string {
  const who = !event.actor || event.actor === SERVER_ITSELF ? null : event.actor === names.viewer ? "You" : event.actor;
  const members = Array.isArray(event.details?.members) ? event.details.members.filter((id): id is string => typeof id === "string") : [];
  const agent = event.agentId ? names.nameOf(event.agentId) : null;
  const title = event.details?.title;

  if (event.kind === "joined" && members.length > 0) {
    const them = listed(members.map(names.nameOf));
    return who ? `${who} started this room with ${them}.` : `This room was started with ${them}.`;
  }
  if (event.kind === "joined" && agent) return who ? `${who} added ${agent} to this room.` : `${agent} was added to this room.`;
  if (event.kind === "left" && agent) return who ? `${who} took ${agent} out of this room.` : `${agent} was taken out of this room.`;
  if (event.kind === "topic" && typeof title === "string") return who ? `${who} named this room "${title}".` : `This room was named "${title}".`;
  if (event.kind === "topic" && title === null) return who ? `${who} cleared this room's name.` : `This room's name was cleared.`;
  return event.text;
}
