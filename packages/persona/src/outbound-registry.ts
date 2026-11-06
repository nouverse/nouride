/**
 * Which agent wrote which message.
 *
 * One small map that answers two questions the daemon could not answer before, and both of them are
 * about a message coming *back*:
 *
 * - **A human replied.** They hit reply on something Nouva said and typed "and the other one too".
 *   No mention, no name — and the platform's reply metadata points at a message id. Without a record
 *   of who wrote it, the router has nothing to go on and the message reaches nobody, which reads as
 *   the agent ignoring them.
 * - **An agent tagged another agent.** The message our own bot sent arrives back as an inbound event.
 *   Recognising it by id is what tells us it is ours rather than a stranger's — and *whose* it is,
 *   which the platform cannot say when several agents share one bot token.
 *
 * That second use is why this is keyed on the message id rather than on the bot's user id. With one
 * bot per agent the author would be enough; with agents sharing a bot it would not, and the shape
 * that only works for half the deployments is the shape that breaks quietly on the other half.
 *
 * **Keyed by platform, not by connection.** A message id is unique within a platform, and with one bot
 * per agent the platform hands each bot its own copy of the same message — so a lookup scoped to the
 * connection that *sent* it finds nothing on any of the others. That is not a missing hint, it is a
 * wrong answer: `classifyInbound` reads "no known author" as somebody else's bot and drops the
 * message. Handovers between agents on separate tokens could not work at all — Nouva wrote a correct
 * mention of Nexa, Nouva's own connection deferred to whoever was addressed, and Nexa's connection
 * threw the message away as foreign. Nobody ran, and nothing was logged as an error.
 *
 * The hop budget moves with it, and belongs there anyway: a chain between agents is a property of the
 * conversation, not of the connection that happened to carry a message. Per connection it was six
 * separate budgets for one exchange.
 *
 * In memory and bounded. It is a routing hint for a conversation still in progress, not a record —
 * losing it on restart means a reply falls back to the platform's word, `repliesToSelf`: which bot
 * wrote the quoted message, and so the agent that owns it, if not which of several sharing one.
 */

import { createLogger } from "@nouride/shared";

const log = createLogger("agents.outbound");

/**
 * Messages remembered per conversation.
 *
 * A reply to something from an hour ago is rare, and a reply to something from three messages ago is
 * the whole use case. Sixty is generous for the second and costs a few kilobytes.
 */
const MAX_PER_CHAT = 60;

/** Conversations tracked at once. A daemon with more live chats than this has bigger questions. */
const MAX_CHATS = 200;

interface Entry {
  messageId: string;
  agentId: string;
}

interface Conversation {
  entries: Entry[];
  /**
   * How many times agents have handed work to each other here without a human speaking.
   *
   * Kept beside the message ids rather than in a second map keyed the same way. Two maps over one
   * conversation is two lifetimes to keep in step: the eviction below would drop the ids and leave the
   * count behind, and a chat evicted mid-exchange would come back with its budget already spent. One
   * record, one eviction, one `clear`.
   */
  hops: number;
}

export class OutboundRegistry {
  private byChat = new Map<string, Conversation>();

  private key(platform: string, chatId: string): string {
    return `${platform} ${chatId}`;
  }

  /** Record that `agentId` sent `messageId` here. Ignored when the platform gave us no id. */
  record(input: {
    /** The platform, not the connection — every connection on it sees the same message id. */
    platform: string;
    chatId: string;
    messageId: string | undefined;
    agentId: string;
  }): void {
    if (!input.messageId) return;

    const key = this.key(input.platform, input.chatId);
    const chat = this.byChat.get(key) ?? { entries: [], hops: 0 };
    chat.entries.push({ messageId: input.messageId, agentId: input.agentId });
    if (chat.entries.length > MAX_PER_CHAT) {
      chat.entries.splice(0, chat.entries.length - MAX_PER_CHAT);
    }
    this.byChat.set(key, chat);
    this.evict();
  }

  /**
   * Oldest insertion first — `Map` preserves it, so the first key is the least recently created
   * conversation. Not the least recently *used*, which would need a touch on every lookup to buy a
   * precision nothing here needs.
   *
   * Called from every path that can add a conversation. It used to live inline in `record`, which was
   * correct while that was the only one; `setHops` can now create a slot too, and a bound enforced on
   * one of two entry points is not a bound.
   */
  private evict(): void {
    while (this.byChat.size > MAX_CHATS) {
      const oldest = this.byChat.keys().next().value;
      if (oldest === undefined) return;
      this.byChat.delete(oldest);
    }
  }

  /** The agent that wrote a message, or null. */
  authorOf(platform: string, chatId: string, messageId: string | undefined): string | null {
    if (!messageId) return null;
    const chat = this.byChat.get(this.key(platform, chatId));
    return chat?.entries.find((entry) => entry.messageId === messageId)?.agentId ?? null;
  }

  /** Handovers so far in this conversation. */
  hops(platform: string, chatId: string): number {
    return this.byChat.get(this.key(platform, chatId))?.hops ?? 0;
  }

  /**
   * Record the chain depth, or reset it to zero when a human speaks — or ends the conversation (`resetHops` in
   * `conversation-end.ts`), which keeps who wrote what: authorship is a fact about a message, not about a conversation.
   *
   * A conversation with no messages recorded yet still gets a slot, because the count has to survive
   * from the moment an agent is first addressed — before anything of ours has been sent.
   */
  setHops(platform: string, chatId: string, hops: number): void {
    const key = this.key(platform, chatId);
    const chat = this.byChat.get(key);
    if (chat) {
      chat.hops = hops;
      return;
    }
    if (hops === 0) return; // nothing to remember, and no reason to take a slot
    this.byChat.set(key, { entries: [], hops });
    this.evict();
  }

  size(): number {
    return this.byChat.size;
  }

  stats(): { chats: number; messages: number } {
    let messages = 0;
    for (const chat of this.byChat.values()) messages += chat.entries.length;
    if (messages > MAX_PER_CHAT * MAX_CHATS) log.warn("outbound registry is larger than expected");
    return { chats: this.byChat.size, messages };
  }
}
