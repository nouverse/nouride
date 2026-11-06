/**
 * What a Telegram message becomes before the engine sees it — `MessageEnvelope` — and what an edit of one becomes.
 *
 * Out of the adapter's file, which keeps the connection: who a message addresses, what it quotes, whether it was
 * forwarded and where its chat is are each a decision about one message, testable without a bot.
 */

import type { Message } from "grammy/types";
import type { MessageEnvelope } from "@nouride/shared";
import { telegramAttachments } from "./attachments.ts";

/** This connection: its instance id, and the bot it is once connected. */
export interface TelegramSelf {
  gatewayId: string;
  me: { id: number; username?: string } | undefined;
}

/** A chat, with its topic folded in: a topic thread is a conversation of its own — `-100123:45`. */
export function foldChatId(chatId: number | string, threadId: number | undefined): string {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

/** A group's or a channel's title — its name on Telegram (0.7.24). Nothing for a one-to-one: a person is not a room. */
export function telegramRoomTitle(chat: { type: string; title?: string }): string | undefined {
  if (chat.type === "private") return undefined;
  return chat.title?.trim() || undefined;
}

/**
 * A forum topic's name, where a message says it: the topic being created or renamed, or a message in a topic, which
 * Telegram sends as a reply to the topic's creation.
 */
export function topicNameOf(message: Pick<Message, "forum_topic_created" | "forum_topic_edited" | "reply_to_message" | "message_thread_id">): string | undefined {
  if (!message.message_thread_id) return undefined;
  return message.forum_topic_edited?.name ?? message.forum_topic_created?.name ?? message.reply_to_message?.forum_topic_created?.name ?? undefined;
}

/** The chat's kind as the engine names it. */
export function chatTypeOf(type: string): MessageEnvelope["chatType"] {
  return type === "private" ? "dm" : type === "channel" ? "channel" : "group";
}

/** Who wrote it, as a person reads a name — their name, else their username. */
export function displayName(from: { first_name?: string; last_name?: string; username?: string } | undefined): string {
  return [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "unknown";
}

export function telegramEnvelope(message: Message, self: TelegramSelf): MessageEnvelope | null {
  const { text, mentions, mentionsSelf } = telegramMentions(message, self.me);
  const attachments = telegramAttachments(message);
  // Text OR media OR a bare tag. A photo with no caption is a real message someone sent, and
  // dropping it made the bot look like it ignored them — the sender got no reply and no error. A
  // bare `@this_bot` is the same: somebody addressed us without needing words.
  if (!text.trim() && attachments.length === 0 && !mentionsSelf) return null;
  // Our own messages come back on some updates; answering them is how loops start.
  if (message.from?.id === self.me?.id) return null;

  return {
    id: String(message.message_id),
    timestamp: message.date * 1000,
    gateway: "telegram",
    gatewayId: self.gatewayId,
    // A topic thread is a separate conversation, so it belongs in the id that keys the
    // session — otherwise every topic in a forum group shares one context.
    chatId: foldChatId(message.chat.id, message.message_thread_id),
    chatType: chatTypeOf(message.chat.type),
    senderId: String(message.from?.id ?? message.chat.id),
    ...(message.from?.is_bot ? { senderIsBot: true } : {}),
    senderName: displayName(message.from),
    text,
    ...quotedContext(message),
    ...forwardedContext(message),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(message.reply_to_message ? { replyTo: String(message.reply_to_message.message_id) } : {}),
    mentions,
    ...(mentionsSelf ? { mentionsSelf: true } : {}),
    ...(repliesToSelf(message, self.me) ? { repliesToSelf: true } : {}),
    ...(message.chat.type === "group" ? { idsPerConnection: true } : {}),
    raw: message,
  };
}

/**
 * An edited message — `edited_message` — as the edit it is (G11): what the message says now, the message it changes
 * (`edit.of`, its own id), and when that was sent (`date`; `edit_date` is the edit's). The id is the edit's own — the
 * message's and when it was edited — because an edit is not the message: the engine's claim, inbox and queue each know a
 * message by its id, and the same edit delivered twice is the same id.
 *
 * Words only: an edit's file is not sent again. A person's edit only — a bot's is never one (G11 is about people), and
 * our own edits of our progress lines would otherwise come back as edits. One that leaves no words is not one either.
 */
export function telegramEdit(message: Message, self: TelegramSelf): MessageEnvelope | null {
  if (message.from?.is_bot) return null;
  const said = telegramEnvelope(message, self);
  if (!said || !said.text.trim()) return null;
  const { attachments: _attachments, ...words } = said;
  const editedAt = (message.edit_date ?? message.date) * 1000;
  return { ...words, id: `${message.message_id}:edited:${editedAt}`, timestamp: editedAt, edit: { of: String(message.message_id), sentAt: message.date * 1000 } };
}

/**
 * Whether the message was forwarded from somebody else (`MessageEnvelope.forwarded`). Telegram marks a forward with
 * `forward_origin` and puts the forwarded words in the message's own text — words the sender passed on, not wrote.
 */
export function forwardedContext(message: Message): { forwarded?: true } {
  return message.forward_origin !== undefined ? { forwarded: true } : {};
}

/**
 * The quoted message, as envelope fields rather than as part of `text`.
 *
 * Telegram delivers `reply_to_message` as a full object inside the same payload — no extra API call.
 * It used to be prepended to the body, which broke every slash command sent as a reply: see
 * `MessageEnvelope.quotedText` for what that cost. The pipeline composes it into what the model sees.
 */
export function quotedContext(message: Message): { quotedText?: string; quotedSender?: string } {
  const replied = message.reply_to_message;
  if (!replied) return {};

  const quotedText = (replied.text ?? replied.caption ?? "").trim();
  if (!quotedText) return {};

  const quotedSender =
    [replied.from?.first_name, replied.from?.last_name].filter(Boolean).join(" ") ||
    replied.from?.username ||
    "";

  return { quotedText, ...(quotedSender ? { quotedSender } : {}) };
}

/**
 * Whether the message replies to one this bot sent (`MessageEnvelope.repliesToSelf`).
 *
 * Not to a topic's opening: in a forum every message of a topic carries the service message that created it as
 * `reply_to_message`, and a topic our bot opened would make every message in it read as a reply to us.
 */
export function repliesToSelf(message: Pick<Message, "reply_to_message">, me: { id: number } | undefined): boolean {
  const replied = message.reply_to_message;
  return Boolean(me && replied && !replied.forum_topic_created && replied.from?.id === me.id);
}

/**
 * Who a message addresses: the usernames it tags, and whether this bot is one of them.
 *
 * Telegram addresses a bot by `@username`, so its own username is how this bot is tagged — and it has
 * to come back as `mentionsSelf`, not as one more name in `mentions`. It used to come back as a name:
 * the router matched `infrasecaxl_bot` against agent names, found none, read the message as "somebody
 * else was tagged", and dropped it on every connection, the tagged bot's own included. Only an agent
 * id typed into the text was answered. Discord has always had this right; this is the same rule.
 *
 * A leading tag of our own is stripped from the text, as on Discord, so the model does not read its
 * bot's name as the first word of every message. A bare tag leaves the text empty and is still
 * delivered — it is how people say "look at this" to a bot in a group.
 *
 * A command addressed to one bot — `/status@RenNourideBot`, what Telegram's own command menu writes
 * in a group — is a mention too. It carries no `mention` entity, so it used to be nobody's: every
 * connection read it as unaddressed and the command went unanswered. Ours becomes `/status` and
 * `mentionsSelf`; another bot's is a mention of that bot.
 */
export function telegramMentions(
  message: Pick<Message, "text" | "caption" | "entities" | "caption_entities">,
  me: { id: number; username?: string } | undefined,
): { mentions: string[]; mentionsSelf: boolean; text: string } {
  const entities = message.entities ?? message.caption_entities ?? [];
  const source = message.text ?? message.caption ?? "";
  const own = me?.username?.toLowerCase();
  const mentions: string[] = [];
  let mentionsSelf = false;

  for (const entity of entities) {
    let name: string | undefined;
    let self = false;
    if (entity.type === "mention") {
      name = source.slice(entity.offset + 1, entity.offset + entity.length);
      self = Boolean(own) && name.toLowerCase() === own;
    } else if (entity.type === "text_mention") {
      name = entity.user.username;
      self = me !== undefined && entity.user.id === me.id;
    } else if (entity.type === "bot_command") {
      const command = source.slice(entity.offset, entity.offset + entity.length);
      const at = command.indexOf("@");
      if (at < 0) continue;
      name = command.slice(at + 1);
      self = Boolean(own) && name.toLowerCase() === own;
    }
    if (self) mentionsSelf = true;
    else if (name) mentions.push(name);
  }

  const text =
    own && mentionsSelf
      ? source
          .replace(new RegExp(`^(\\s*@${escapeRegExp(own)}\\b)+\\s*`, "i"), "")
          .replace(new RegExp(`^(\\s*/[a-z0-9_]+)@${escapeRegExp(own)}\\b`, "i"), "$1")
      : source;
  return { mentions, mentionsSelf, text };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
