/**
 * Who may see what — `docs/SPEC.md` §12.3. One rule for conversations and for the facts learned
 * from them, decided by who was in the conversation and never by a model:
 *
 * - **A DM with P** sees what P took part in, on any agent.
 * - **A group** sees what was said in that group.
 *
 * A fact carries its source conversation's audience (`profile.ts`, `Readers`), so it is readable
 * exactly where that conversation is. A fact a person wrote by hand has none, and is readable wherever
 * its subject is present.
 *
 * The owner is not special here: their DM reaches their own conversations across agents, the same as
 * anyone's, and never someone else's DM.
 *
 * Pure.
 */

import type { ChatType } from "@nouride/shared";
import type { Readers } from "./profile.ts";

export type Audience =
  /** One person. `person` is their identity: a person key, or a platform id. */
  | { kind: "dm"; chat: string; person: string }
  /** A group: its chat, and the people known to be speaking in it. */
  | { kind: "group"; chat: string; present: readonly string[] };

/**
 * The chat as memory records it. One spelling, so an episode and an audience always compare.
 *
 * Not the approval floor's `chatKey`, which is length-prefixed: this one is stored with every episode, so it keeps its
 * `gateway:chat` encoding and a name that cannot be auto-imported in its place.
 */
export function memoryChatKey(gatewayId: string, chatId: string): string {
  return `${gatewayId}:${chatId}`;
}

export function audienceOf(input: { chat: string; chatType: ChatType; person: string; present?: readonly string[] }): Audience {
  if (input.chatType === "dm") return { kind: "dm", chat: input.chat, person: input.person };
  return { kind: "group", chat: input.chat, present: [...new Set([input.person, ...(input.present ?? [])])] };
}

export function canSeeEpisode(episode: { chat: string; people: readonly string[] }, audience: Audience): boolean {
  if (episode.chat === audience.chat) return true;
  return audience.kind === "dm" && episode.people.includes(audience.person);
}

/**
 * The same rule as `canSeeEpisode`, as the index is asked it: episodes of this chat, and in a DM also
 * those this person took part in. A query over thousands of episodes filters in SQL with this; the
 * tests hold the two to the same answers.
 */
export interface EpisodeScope {
  chat: string;
  participant?: string;
}

export function scopeOf(audience: Audience): EpisodeScope {
  return audience.kind === "dm" ? { chat: audience.chat, participant: audience.person } : { chat: audience.chat };
}

export function canSeeFact(fact: { readers?: Readers }, subject: string, audience: Audience): boolean {
  if (!fact.readers) return audience.kind === "dm" ? audience.person === subject : audience.present.includes(subject);
  if (audience.kind === "dm") return fact.readers.people.includes(audience.person);
  return fact.readers.chat === audience.chat;
}

/** The audience an episode's facts are stamped with: who took part, and the chat when it was a group. */
export function readersOf(episode: { kind: string; chat: string; people: readonly string[] }): Readers {
  return { people: [...episode.people], ...(episode.kind === "group" ? { chat: episode.chat } : {}) };
}
