/**
 * What the room said while nobody was addressing the agent.
 *
 * In a group an agent only ever saw the one message that tagged it. "@nouva ini" pointed at an
 * exchange it had no record of, so it answered by asking what "ini" was — twice, in a Discord channel
 * and a WhatsApp group, which is what this exists to fix.
 *
 * **The messages are already at the door.** Every adapter emits everything in a channel; the router
 * drops what is not addressed (`apps/engine/src/modules/pipeline/inbound.ts`, the `!decision.agent`
 * return). So this is a buffer of
 * what was being thrown away, not a call back to the platform — and that distinction is what makes it
 * work everywhere: the Telegram Bot API has no way to fetch messages a bot did not receive, so an
 * implementation that read history would have been Discord-only while looking uniform. Nothing here
 * knows which platform it is holding, per the adapter-boundary rule.
 *
 * **In memory, deliberately.** This is minutes of small talk that rebuilds itself as people keep
 * typing. A table for it would be a second store of the same conversation the session store already
 * owns, with a retention sweep and a migration behind it, to save context that is worthless by the
 * time anyone reads it twice. A restart loses the window; the next few messages restore it.
 */

import { clip, GROUP_CONTEXT_MAX, type MessageEnvelope, oneLine, plural } from "@nouride/shared";

/**
 * Rooms held at once. Past this the least recently active one is dropped.
 *
 * Bounded for the same reason the claim table is: the map only grows while messages arrive, and a
 * daemon in a hundred channels should not hold a buffer for every channel it has ever seen.
 */
const MAX_ROOMS = 500;

/**
 * Characters kept from one message **in memory**.
 *
 * A memory bound, not a display decision — the two used to be the same number and that was the mistake.
 * The buffer holds twice the window, so without any cap one pasted 6MB log would sit in it for as long
 * as the room stays warm.
 *
 * Generous, because what the model actually sees is decided at format time against a budget for the
 * whole block. Cutting here as well would mean a message could never be shown in full however much room
 * the block had.
 */
const MAX_STORED_CHARS = 4_000;

/**
 * Characters the whole replayed block may occupy — roughly 1500 tokens.
 *
 * **One budget for the block, spent newest-first**, rather than a cap on each line. The per-line
 * version bounded the wrong thing: at 400 characters a chatter message was never truncated (nobody
 * types that much in a channel) while an agent's answer always was — so the one message you would
 * actually want to replay in full, because reviewing it is why the next agent was tagged, was the only
 * one guaranteed to arrive as a stub. And the block's real size was `window × cap`, so raising the cap
 * to fix that multiplied the worst case by twenty.
 *
 * Fixed rather than derived from the model's window: it is already small enough not to matter on a
 * large one, and deriving it here would be a second copy of a resolution that lives in the executor.
 * What makes the block useful is the *order* it spends this in, not the size of it.
 */
const BLOCK_MAX_CHARS = 6_000;

/**
 * Below this there is no point including a message at all.
 *
 * Forty characters of a paragraph tells the model something exists and nothing about what it said,
 * which is worse than the honest "N older messages are not shown" it would otherwise get.
 */
const MIN_USEFUL_CHARS = 120;

/**
 * How much the buffer holds for a window of `limit`.
 *
 * Twice, because `since` filters the buffer and a filtered-out message must not cost a line of real
 * context. The tag itself is the guaranteed case — it is a message in the room like any other, so a
 * buffer sized exactly to the window spent one slot on the question and replayed nineteen of twenty.
 * At a window of 2 that was one line. Doubling covers the worst realistic mix, where every other
 * message is a tag or one of our own agents answering.
 */
function capacityFor(limit: number): number {
  return limit * 2;
}

export interface OverheardMessage {
  /** Platform message id, so the same message arriving on six connections is stored once. */
  id: string;
  /** The connection and account it came from, so the name is the `[[people]]` one when it is read (`speakerName`). */
  gatewayId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  /** Set when one of our own agents wrote it, from the outbound registry. */
  fromAgent?: string;
  /**
   * The agents that took it as theirs and answered it (`answering`) — never overheard by them later. Their history
   * holds it, until a rollover or a `/new` empties the history and the window falls back to the buffer: live
   * (2026-10-22), the front desk's first message of the day carried the question it had answered the evening before,
   * under "you were not addressed in them", and it asked who the two messages were for.
   */
  answeredBy?: string[];
}

/**
 * How many messages to keep and replay for one connection.
 *
 * Both inputs are validated at load (`validate` in `config/global/validate.ts`, `parseGatewayInstance` in
 * `config/global/open-sections.ts` for the per-connection override), so this only resolves precedence and re-applies the ceiling — a live
 * config edit from the dashboard does not go through the loader.
 */
export function resolveGroupContextLimit(
  instance: number | undefined,
  fallback: number,
): number {
  const raw = instance ?? fallback;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(GROUP_CONTEXT_MAX, Math.max(0, Math.trunc(raw)));
}

export interface SinceQuery {
  /** Platform, not connection — see the class docstring on why the key is the room. */
  gateway: string;
  chatId: string;
  /** Exclusive lower bound: when the agent was last spoken to in this chat. */
  after: number;
  /** Exclusive upper bound: when the triggering message arrived. */
  before: number;
  /**
   * Text this turn is already carrying — the triggering message, and whatever it quoted.
   *
   * Compared for equality after both sides are flattened, so it is exact rather than a substring
   * guess: "ok" would be a substring of almost any question, and dropping the room's "ok" because the
   * question happens to contain those two letters loses real context.
   */
  carried: string[];
  limit: number;
  /** The agent about to answer. Its own messages are already in its history as `assistant`. */
  excludeAgent: string;
}

/**
 * Whether `held` is `envelope`, as delivered again: by id — or, where ids are per connection and the copies share none,
 * by what they are: the same person, the same second, the same words.
 */
function isCopy(held: OverheardMessage, envelope: MessageEnvelope, text: string): boolean {
  return (
    held.id === envelope.id ||
    (envelope.idsPerConnection === true &&
      held.timestamp === envelope.timestamp &&
      held.text === text &&
      held.senderName === (envelope.senderName || envelope.senderId))
  );
}

export class GroupContext {
  /**
   * Keyed by `platform:chatId` — the *room*, not the connection.
   *
   * Six bots in one Discord channel are six connections onto one conversation, and keying by
   * `gatewayId` would hold six copies of it and let each agent overhear only its own deliveries.
   * Insertion order doubles as the LRU: `record` re-inserts, so the first key is the coldest room.
   */
  private readonly rooms = new Map<string, OverheardMessage[]>();

  private static key(gateway: string, chatId: string): string {
    return `${gateway}:${chatId}`;
  }

  /**
   * Remember one message. Returns false when it was a copy already held.
   *
   * The copies are not hypothetical: a platform hands every channel message to every bot on it, so
   * one message arrives once per connection, within milliseconds. Deduplicated by scanning the buffer
   * rather than with a second `seen` set — the copies are adjacent, and a set would be one more thing
   * to bound and sweep for no additional coverage.
   */
  record(envelope: MessageEnvelope, limit: number, fromAgent?: string): boolean {
    if (limit <= 0) return false;

    const text = flattenLine(envelope.text);
    if (!text) return false;

    const key = GroupContext.key(envelope.gateway, envelope.chatId);
    const existing = this.rooms.get(key);
    if (existing?.some((message) => isCopy(message, envelope, text))) return false;

    const buffer = existing ?? [];
    buffer.push({
      id: envelope.id,
      gatewayId: envelope.gatewayId,
      senderId: envelope.senderId,
      senderName: envelope.senderName || envelope.senderId,
      text,
      timestamp: envelope.timestamp,
      ...(fromAgent ? { fromAgent } : {}),
    });
    // Trimmed against the *current* setting, so lowering it in the dashboard stops holding the
    // surplus on the next message rather than at the next restart. What is replayed is `since`'s
    // business; this is only how much is kept.
    const capacity = capacityFor(limit);
    if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);

    // Delete-then-set, so the map's insertion order is least-recently-active first.
    this.rooms.delete(key);
    this.rooms.set(key, buffer);
    this.evictColdRooms();
    return true;
  }

  /** `envelope`, held here, is the one `agentId` is answering: it is never overheard by that agent again. */
  answering(envelope: MessageEnvelope, agentId: string): void {
    const text = flattenLine(envelope.text);
    const message = this.rooms.get(GroupContext.key(envelope.gateway, envelope.chatId))?.find((held) => isCopy(held, envelope, text));
    if (!message || message.answeredBy?.includes(agentId)) return;
    message.answeredBy = [...(message.answeredBy ?? []), agentId];
  }

  /**
   * What was said in this room since the agent was last spoken to, oldest first.
   *
   * Every filter here exists to stop the model reading one message twice:
   *
   * - **`after`** is when the agent was last addressed. Anything older is either in its stored
   *   history or was replayed into a previous turn's block.
   * - **`before`** is when the triggering message arrived, and it is exclusive. The trigger is the
   *   turn's actual user message; Telegram dates messages in whole seconds, so this also drops
   *   chatter from the same second as the question, which is the right second to lose.
   * - **`carried`** covers what the turn is already sending: the triggering text, and the message it
   *   replied to. A reply-and-tag is the ordinary way to ask an agent about something above — the
   *   quote is prepended to the question, and the buffer holds that same message as chatter.
   * - **the answering agent's own messages**, which its history holds as `assistant`.
   * - **the messages it answered**, which its history holds as `user` — until it is emptied (`answeredBy`).
   */
  since(query: SinceQuery): OverheardMessage[] {
    if (query.limit <= 0) return [];
    const buffer = this.rooms.get(GroupContext.key(query.gateway, query.chatId));
    if (!buffer) return [];

    // A merged media burst arrives as one envelope whose text is the pieces joined by a blank line,
    // so the pieces are what has to be matched, not the join.
    const carried = new Set(
      query.carried
        .flatMap((text) => text.split("\n\n"))
        .map(flattenLine)
        .filter(Boolean),
    );

    return buffer
      .filter(
        (message) =>
          message.timestamp > query.after &&
          message.timestamp < query.before &&
          message.fromAgent !== query.excludeAgent &&
          !message.answeredBy?.includes(query.excludeAgent) &&
          !carried.has(message.text),
      )
      .slice(-query.limit);
  }

  /**
   * A message held here, edited by whoever sent it (G11): it says what it says now. False when it is not held — gone
   * from the window, or never heard. An edit is not a message of its own here: nobody said a second thing.
   */
  revise(gateway: string, chatId: string, id: string, text: string): boolean {
    const message = this.rooms.get(GroupContext.key(gateway, chatId))?.find((held) => held.id === id);
    const flat = flattenLine(text);
    if (!message || !flat) return false;
    message.text = flat;
    return true;
  }

  /** Rooms currently held, so a test can catch the map growing without bound. */
  size(): number {
    return this.rooms.size;
  }

  private evictColdRooms(): void {
    while (this.rooms.size > MAX_ROOMS) {
      const coldest = this.rooms.keys().next();
      if (coldest.done) return;
      this.rooms.delete(coldest.value);
    }
  }
}

/**
 * The block that goes in front of the question.
 *
 * In the user message, not the system prompt: the prompt's stable prefix is what providers cache
 * (the system blocks and their hints, `llm/prompt/index.ts`), and a section that changes every turn would miss the cache on every
 * turn. It also has to be one flat string rather than replayed `user` messages — a turn is the unit
 * of truncation here (`groupTurns`), and fake turns would let a trim cut between them.
 *
 * Labelled as background and explicitly not a question, because the whole content of the block is
 * other people asking each other things. Without the label the model answers the chatter instead of
 * the person who tagged it.
 */
export function formatOverheard(messages: Pick<OverheardMessage, "senderName" | "text">[], budget = BLOCK_MAX_CHARS): string {
  if (messages.length === 0) return "";

  /**
   * Spent from the newest backwards, and that order is the whole design.
   *
   * The newest message is the one the tag is about — an agent asked to review what another just said
   * needs that answer in full far more than it needs the small talk from ten minutes ago. Older lines
   * are worth having and worth losing first, which is exactly what a budget walked in this direction
   * expresses and what a per-line cap could not.
   */
  const kept: string[] = [];
  let spent = 0;
  let shown = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;

    const prefix = `${message.senderName}: `;
    const room = budget - spent - prefix.length - 1;
    if (room < MIN_USEFUL_CHARS) break;

    const text = clip(message.text, room, room);
    kept.push(`${prefix}${text}`);
    spent += prefix.length + text.length + 1;
    shown += 1;
  }

  kept.reverse();
  const dropped = messages.length - shown;

  return [
    `[the ${shown} ${plural(shown, "message")} before this one in the chat, oldest first. ` +
      `You were not addressed in them. They are background only: do not reply to them, and do not bring up ` +
      `anything from them unless the message after them (the one you are answering) asks about it.` +
      // Said out loud, because a model that cannot tell a short room from a trimmed one will answer as
      // if it has the whole conversation.
      (dropped > 0 ? ` ${dropped} older ${plural(dropped, "message")} did not fit and are not shown.]` : "]"),
    ...kept,
  ].join("\n");
}

/**
 * The timestamp of the last message the agent was *spoken to* with.
 *
 * The last `user` message, not the last message of any role: assistant and tool messages are stamped
 * when they are produced, and a turn that spends thirty seconds in a tool would stamp its reply after
 * chatter that arrived while it ran — so keying on it would silently swallow exactly the messages the
 * agent missed while it was busy.
 */
export function lastAddressedAt(messages: { role: string; timestamp?: number }[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.timestamp === "number") return message.timestamp;
  }
  return 0;
}

/** One line per message, so the block keeps its shape whatever anyone pasted into the chat. */
function flattenLine(text: string): string {
  return clip(oneLine(text), MAX_STORED_CHARS, MAX_STORED_CHARS);
}
