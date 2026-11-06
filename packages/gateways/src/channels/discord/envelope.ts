/**
 * What a Discord message becomes before the engine sees it — `MessageEnvelope` — and what an edit of one becomes.
 *
 * Out of the adapter's file, which keeps the client: who a message addresses, whether it is a turn at all and what it
 * refers to are each a decision about one message, testable on a message shaped the way discord.js hands it over.
 */

import { ChannelType, type Message } from "discord.js";
import type { MessageEnvelope } from "@nouride/shared";
import { discordAttachments } from "./attachments.ts";
import { referencedContext } from "./references.ts";

export async function discordEnvelope(message: Message, gatewayId: string): Promise<MessageEnvelope | null> {
  // Read off the live client rather than cached at ready: a reconnect builds a new client, and a
  // stored id from the previous one would silently stop matching.
  const selfId = message.client.user?.id;

  // Reported, not dropped.
  //
  // This used to be `if (message.author.bot) return null` — every bot, with the reason spelled out:
  // two Nouride agents in one channel would otherwise answer each other indefinitely. That reason is
  // still right and the answer has moved: the daemon decides, because whether a bot is *ours* is
  // something only it can know, and the runaway is now bounded by a hop budget rather than by
  // refusing the whole category. A message from somebody else's bot is still dropped — one line
  // further on, in `admit`.
  // Our own tag comes off the front of the text.
  //
  // Discord delivers a mention as `<@id>`, and in a channel where an agent only answers when
  // addressed, tagging it is the normal way to talk to it — so "<@self> /approve" is what a slash
  // command looks like in practice. The engine parses a command only from text that *starts* with
  // `/`, and its queue decides urgency the same way, so leaving the tag in place meant `/approve`
  // was neither recognised as a command nor let past the queue: it lined up behind the very turn
  // that was waiting to be approved, and the only way to answer was unreachable until that turn
  // timed out.
  //
  // Only leading, and only ours. A tag in the middle is part of what the person wrote, and a tag
  // naming somebody else is information the agent needs.
  const raw = message.content ?? "";
  const text = stripLeadingSelfMention(raw, selfId).trim();
  const attachments = discordAttachments([...(message.attachments?.values() ?? [])]);

  // Read off the text, not off `message.mentions` — see `writtenMentions`. The raw content, because
  // our own tag has just been stripped from `text`, and being addressed is exactly what that means.
  const { mentions, mentionsSelf } = writtenMentions({
    content: raw,
    users: [...(message.mentions?.users?.values() ?? [])],
    selfId,
  });
  if (!worthDelivering({ text, attachmentCount: attachments.length, mentionsSelf })) return null;

  // The message this one is about — replied to, or linked.
  //
  // Discord delivers only a reference (id + channel id), not the content, so a reply costs one
  // extra fetch; a pasted link costs two. Both end up as the same two envelope fields, and both
  // fail silently — see `references.ts` for what a bare unresolved link cost us before this.
  const quoted = await referencedContext(message, text);

  return {
    id: message.id,
    timestamp: message.createdTimestamp,
    gateway: "discord",
    gatewayId,
    // A thread has its own channel id, which is exactly the per-thread session scoping
    // §6.4 SPEC asks for — no special handling needed.
    chatId: message.channelId,
    chatType: chatTypeOf(message.channel.type),
    senderId: message.author.id,
    senderName: message.member?.displayName ?? message.author.username,
    ...(message.author.bot ? { senderIsBot: true } : {}),
    text: text ?? "",
    ...quoted,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(message.reference?.messageId ? { replyTo: message.reference.messageId } : {}),
    mentions,
    // Asked of the platform, not inferred from a name. A bot's Discord username carries whatever
    // the application is called — "Nero | Infra Agent" — and comparing that to an agent id never
    // matched, so an explicit tag routed to nobody.
    ...(mentionsSelf ? { mentionsSelf: true } : {}),
    ...(repliesToSelf(message, selfId) ? { repliesToSelf: true } : {}),
    raw: message,
  };
}

/**
 * Whether the message replies to one this bot sent (`MessageEnvelope.repliesToSelf`): Discord names the replied
 * message's author as `mentions.repliedUser`, whether or not the reply pinged them. Only for a reply — a pasted link to
 * one of ours is a reference too, and not an answer to it.
 */
function repliesToSelf(
  message: { reference?: { messageId?: string | undefined } | null; mentions?: { repliedUser?: { id: string } | null } | null },
  selfId: string | undefined,
): boolean {
  return Boolean(selfId && message.reference?.messageId && message.mentions?.repliedUser?.id === selfId);
}

/**
 * A message updated — `messageUpdate` — as the edit it is, when it is one (G11): what the message says now, the message
 * it changes (`edit.of`) and when that was sent. Discord updates a message for more than a person's edit — an embed
 * loading for a link in it, a pin — and only an edit moves `editedTimestamp`, so a message never edited is not one; an
 * embed loading after an edit carries the edit's time again, and the id made of it is the same one the engine already
 * holds. A bot's update is never one: G11 is about people, and our own progress lines are edited all the time.
 *
 * Words only: an edit's file is not sent again. One that leaves no words is not one either.
 */
export async function discordEdit(message: Message, gatewayId: string): Promise<MessageEnvelope | null> {
  if (message.partial || message.author?.bot || !message.editedTimestamp) return null;
  const said = await discordEnvelope(message, gatewayId);
  if (!said || !said.text.trim()) return null;
  const { attachments: _attachments, ...words } = said;
  return {
    ...words,
    id: `${message.id}:edited:${message.editedTimestamp}`,
    timestamp: message.editedTimestamp,
    edit: { of: message.id, sentAt: message.createdTimestamp },
  };
}

/**
 * Does the text itself tag this user?
 *
 * The distinction this draws is the whole point: `message.mentions.users` is who Discord *attached*
 * to a message, and that includes the author of whatever is being replied to, because a reply pings
 * them. This daemon sends every reply with `repliedUser: true` (see `deliver`), so one agent
 * answering another produces, on the other agent's connection, a message the platform reports as a
 * mention although nobody wrote one.
 *
 * Read as an address, that is a baton nobody handed over. Live: Nero reported, Nox replied, the reply
 * pinged Nero, Nero's reply pinged Nox, and the two woke each other eleven times until the hop budget
 * stopped them — and the budget's own "I am leaving it there" notice went out as a reply too, so it
 * pinged back and started one more turn. The brake did not brake. The operator ended it with `/stop`.
 *
 * A tag in the text is a decision; a ping riding on a reply is bookkeeping. Only the first is an
 * address. Nothing is lost for people: a human who replies without typing a tag still reaches the
 * agent they answered, through `replyTo` and the router's `reply` reason, which is a separate path
 * and deliberately does not satisfy the agent-to-agent mention rule.
 *
 * Both spellings, because Discord has sent both — the same reason `stripLeadingSelfMention` matches
 * `<@!id>`. The id is checked for digits first: it is interpolated into a pattern, and a snowflake is
 * the only thing that ever belongs there.
 */
export function tagsUser(content: string, id: string): boolean {
  if (!/^\d+$/.test(id)) return false;
  return new RegExp(`<@!?${id}>`).test(content);
}

/**
 * Who this message addresses: the users its own text tags, and whether we are one of them.
 *
 * One function rather than two `tagsUser` calls at the call site, because the two answers have to
 * come from the same rule. The bug above was exactly a place where they did not — `mentionsSelf` and
 * `mentions` were both taken from what the platform attached, and a reply's ping satisfied both.
 *
 * `mentions` carries each tagged user twice, by name and by id, because the router matches an agent
 * against either and only the id survives an application being renamed.
 */
export function writtenMentions(input: {
  content: string;
  users: { id: string; username: string }[];
  selfId: string | undefined;
}): { mentions: string[]; mentionsSelf: boolean } {
  const tagged = input.users.filter((user) => tagsUser(input.content, user.id));
  return {
    mentions: [...tagged.map((user) => user.username), ...tagged.map((user) => user.id)],
    mentionsSelf: Boolean(input.selfId && tagsUser(input.content, input.selfId)),
  };
}

/**
 * Whether a message is a turn at all.
 *
 * The default rule is the one every adapter follows: a sticker, a join event, an empty message is not
 * something to wake an agent for.
 *
 * **A bare tag is the exception, and it is the whole point of this function existing.** `@Nouva` on its
 * own is how a person says "look at what I just said", and it is the most common way anyone addresses a
 * bot in a busy channel. The tag is stripped off the front of the text above — so the model does not
 * read its own name as the first token of every message — which left `text` empty, which dropped the
 * message on the emptiness rule. Live, on Discord: tagging an agent with no words did nothing at all,
 * twice, and was indistinguishable from the bot being down.
 *
 * Being tagged is the difference between "nobody said anything" and "somebody addressed me without
 * needing words". Extracted from `discordEnvelope` because that needs a live `Message` and this decision
 * does not.
 */
export function worthDelivering(message: {
  text: string;
  attachmentCount: number;
  mentionsSelf: boolean;
}): boolean {
  if (message.text.trim()) return true;
  if (message.attachmentCount > 0) return true;
  return message.mentionsSelf;
}

/**
 * Remove any run of mentions of `selfId` from the start of the text.
 *
 * `<@123>` and `<@!123>` are the same mention with and without a nickname — Discord has sent both
 * historically, and matching only one leaves the other in place.
 */
export function stripLeadingSelfMention(content: string, selfId: string | undefined): string {
  if (!selfId) return content;
  const leading = new RegExp(`^(?:\\s*<@!?${selfId}>)+`);
  return content.replace(leading, "");
}

/** A channel's kind as the engine names it: a DM, a group DM, or a server channel (a thread is one too). */
function chatTypeOf(type: ChannelType | undefined): "dm" | "group" | "channel" {
  switch (type) {
    case ChannelType.DM:
      return "dm";
    case ChannelType.GroupDM:
      return "group";
    default:
      return "channel";
  }
}
