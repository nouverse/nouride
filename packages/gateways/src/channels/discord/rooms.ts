/**
 * A Discord room's name and a thread's opening message (0.7.24) — `Gateway.roomTitle` and `MessageEnvelope.threadOpener`.
 *
 * A room is a channel id: a server channel, or a thread, which has a channel id of its own and so is its own room. Its
 * name is the channel's, `#general`, or the thread's own; never the server's — no level above a room is modelled.
 */

import { ChannelType } from "discord.js";
import type { ThreadOpener } from "@nouride/shared";

/** The parts of a channel these read, as discord.js hands one over. */
export interface RoomChannel {
  type: ChannelType;
  name?: string | null;
  isThread?(): boolean;
  /** A thread's channel — where the message it started from was written. */
  parent?: { name?: string | null } | null;
  fetchStarterMessage?(): Promise<StarterMessage | null>;
}

/** The parts of a thread's starter message read here. */
export interface StarterMessage {
  id: string;
  content?: string | null;
  author?: { id: string; username: string } | null;
  member?: { displayName?: string | null } | null;
}

/** `#general` for a channel, the thread's own name for a thread, nothing for a one-to-one or a group DM without one. */
export function discordRoomTitle(channel: RoomChannel | null | undefined): string | undefined {
  if (!channel || channel.type === ChannelType.DM) return undefined;
  const name = channel.name?.trim();
  if (!name) return undefined;
  if (channel.isThread?.() || channel.type === ChannelType.GroupDM) return name;
  return `#${name}`;
}

/**
 * What a thread was started from, for a message in it — or nothing: not a thread, a thread with no starter message (one
 * started on its own, or whose starter was deleted), or the message that *is* the starter, as a forum post's first
 * message is. A fetch that fails throws: that is not a thread without one, and is not kept as such.
 */
async function discordThreadOpener(channel: RoomChannel, messageId: string): Promise<ThreadOpener | undefined> {
  if (!channel.isThread?.() || !channel.fetchStarterMessage) return undefined;
  const starter = await channel.fetchStarterMessage();
  if (!starter || starter.id === messageId || !starter.author) return undefined;
  const text = starter.content?.trim();
  if (!text) return undefined;
  const where = discordRoomTitle(channel.parent ? { type: ChannelType.GuildText, name: channel.parent.name ?? null } : null);
  return {
    senderId: starter.author.id,
    senderName: starter.member?.displayName ?? starter.author.username,
    text,
    ...(where ? { where } : {}),
  };
}

/** Discord's error code for a message that does not exist (any more). */
const UNKNOWN_MESSAGE = 10008;

/**
 * Each thread's opener, kept: a message in a thread is answered with what it was started from only on a conversation's
 * first turn, which the adapter cannot see, so it carries the opener on every message — fetched once per thread.
 * Bounded, and cleared wholesale past the cap: one fetch again per thread is what that costs.
 */
export class ThreadOpeners {
  private readonly known = new Map<string, ThreadOpener | null>();

  constructor(private readonly cap = 500) {}

  async of(channelId: string, channel: RoomChannel, messageId: string): Promise<ThreadOpener | undefined> {
    if (!channel.isThread?.()) return undefined;
    if (this.known.has(channelId)) {
      const opener = this.known.get(channelId);
      return opener ?? undefined;
    }
    // A thread's id is its starter message's: that message arriving — a forum post's first — is not "this thread has
    // none", and is not kept as such.
    if (messageId === channelId) return undefined;
    let opener: ThreadOpener | undefined;
    try {
      opener = await discordThreadOpener(channel, messageId);
    } catch (err) {
      // Discord's "Unknown Message": the starter was deleted, so the thread has none. Anything else, asked again later.
      if ((err as { code?: unknown }).code !== UNKNOWN_MESSAGE) return undefined;
    }
    if (this.known.size >= this.cap) this.known.clear();
    this.known.set(channelId, opener ?? null);
    return opener;
  }
}
