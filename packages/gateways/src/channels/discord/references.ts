/**
 * The message a Discord message is *about* — whether it was replied to or merely linked.
 *
 * ## The gap this closes
 *
 * Replying already worked: Discord sends a reference rather than the content, `fetchReference()`
 * fills it in, and `withQuotedContext` renders it above the text. Pasting a **link** to a message
 * did not, and the failure was expensive rather than quiet. Watched live on 2026-09-02: somebody
 * pasted `discord.com/channels/…/…/3333333333333333333` with "ini masih kena?", and the agent —
 * holding a bare URL it could not resolve and a shelf of tools it could — went looking for the id.
 * It grepped memory for it, then ran `git log`, then SSH'd to another machine and ran `git log`
 * there. Six steps, 44.7 seconds, still thinking.
 *
 * Nothing about that is a reasoning failure. An 18-digit number arrived with no indication of what
 * it was, so the model treated it as the only kind of long id it had ever been able to resolve.
 *
 * ## Why it produces a quote rather than something new
 *
 * The whole downstream path already exists — `quotedText`/`quotedSender` on the envelope, rendered
 * by `withQuotedContext` as a `> [Author]: …` block. A linked message *is* quoted context; it just
 * arrives by a different route. Adding a second channel for it would mean a second thing to render,
 * a second thing to truncate, and a second thing to forget about.
 */

import type { Message } from "discord.js";

/**
 * `https://discord.com/channels/<guild>/<channel>/<message>`.
 *
 * `@me` in the guild slot is a DM. `canary.` and `ptb.` are the other clients people copy from, and
 * `discordapp.com` is the old domain that still resolves — all three appear in real pastes, so all
 * three are matched rather than rediscovered one bug report at a time.
 */
const MESSAGE_LINK =
  /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/;

export interface QuotedContext {
  quotedText?: string;
  quotedSender?: string;
}

/** The channel and message a link points at, or null when the text holds no link. */
export function parseMessageLink(text: string): { channelId: string; messageId: string } | null {
  const found = MESSAGE_LINK.exec(text);
  if (!found) return null;
  return { channelId: found[1] as string, messageId: found[2] as string };
}

/**
 * The quoted message, as envelope fields rather than as part of `text`.
 *
 * Discord delivers only a message reference (id + channel id) — not the content — so one
 * `fetchReference()` is needed. A failure is silent: a missing quote is not a reason to drop the
 * inbound message.
 *
 * Kept out of `text` deliberately — see `MessageEnvelope.quotedText`. Prepending it there broke every
 * slash command sent as a reply, `/approve` on an approval prompt included.
 */
async function quotedContext(message: Message): Promise<QuotedContext> {
  if (!message.reference?.messageId) return {};

  try {
    const quoted = await message.fetchReference();
    const quotedText = quoted.content?.trim();
    if (!quotedText) return {};
    return {
      quotedText,
      quotedSender: quoted.member?.displayName ?? quoted.author.username,
    };
  } catch {
    // The quoted message may have been deleted, or the bot may lack access to the channel.
    return {};
  }
}

/**
 * The message a pasted link points at.
 *
 * **Only the first link.** A message can carry five, and five is five round-trips and five quote
 * blocks in the prompt for something the person almost certainly meant as one reference. The first
 * is the one they were talking about; the rest are usually citations.
 *
 * **The channel name travels with the author**, because a link is the one case where the quoted
 * message is somewhere else. `[Sam in #memory-monitoring]` tells the agent both who said it and
 * where the conversation lives — and where it lives is what decides whether this is its own business
 * or something to ask another agent about. Without it the quote reads as though it happened here.
 *
 * Silent on every failure, and there are several worth naming: the bot may not be in that channel,
 * the message may be deleted, the link may point into a guild the bot was never invited to. None of
 * them is a reason to drop what the person actually wrote.
 */
export async function linkedContext(message: Message, text: string): Promise<QuotedContext> {
  const link = parseMessageLink(text);
  if (!link) return {};
  // A link to the message doing the linking, which people do paste. Resolving it would quote the
  // text back at itself.
  if (link.messageId === message.id) return {};

  try {
    const channel = await message.client.channels.fetch(link.channelId);
    if (!channel?.isTextBased()) return {};

    const linked = await channel.messages.fetch(link.messageId);
    const quotedText = linked.content?.trim();
    if (!quotedText) return {};

    const author = linked.member?.displayName ?? linked.author.username;
    // DM channels have no name. Naming the channel is the point of this branch, so where there is
    // none the attribution falls back to the plain author rather than inventing a location.
    const where = "name" in channel && channel.name ? ` in #${channel.name}` : "";
    return { quotedText, quotedSender: `${author}${where}` };
  } catch {
    return {};
  }
}

/**
 * Whichever reference this message carries, with the reply winning.
 *
 * A reply is an explicit act aimed at one message; a link inside a reply is usually supporting
 * material for what is being said about it. Resolving both would put two quotes above one sentence
 * and leave the model to guess which one the person meant.
 */
export async function referencedContext(message: Message, text: string): Promise<QuotedContext> {
  const replied = await quotedContext(message);
  if (replied.quotedText) return replied;
  return await linkedContext(message, text);
}
