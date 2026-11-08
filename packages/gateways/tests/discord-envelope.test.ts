/**
 * What a Discord message becomes before the engine sees it — `discordEnvelope`, on messages shaped the way discord.js hands
 * them over. The decisions in it (`stripLeadingSelfMention`, `writtenMentions`, `worthDelivering`) each had a test; the
 * method that strings them together had none until a mutation sweep of the untested areas.
 */

import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import type { MessageEnvelope } from "@nouride/shared";
import { discordEnvelope, stripLeadingSelfMention } from "../src/channels/discord/envelope.ts";

const SELF = "8888888888888888888";
const OTHER = "1111111111111111111";

function message(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "900",
    createdTimestamp: 1_700_000_000_000,
    channelId: "300",
    channel: { type: ChannelType.GuildText },
    author: { id: "5", username: "ann", bot: false },
    member: { displayName: "Ann" },
    content: "halo",
    attachments: new Map(),
    mentions: { users: new Map() },
    reference: null,
    client: { user: { id: SELF } },
    fetchReference: async () => {
      throw new Error("gone");
    },
    ...over,
  };
}

async function envelopeOf(over: Record<string, unknown> = {}): Promise<Omit<MessageEnvelope, "raw"> | null> {
  const envelope = await discordEnvelope(message(over) as never, "discord:main");
  if (!envelope) return null;
  const { raw: _raw, ...rest } = envelope;
  return rest;
}

describe("a Discord message, as an envelope", () => {
  test("in a server channel, every field", async () => {
    expect(await envelopeOf()).toEqual({
      id: "900",
      timestamp: 1_700_000_000_000,
      gateway: "discord",
      gatewayId: "discord:main",
      chatId: "300",
      chatType: "channel",
      senderId: "5",
      senderName: "Ann",
      text: "halo",
      mentions: [],
    });
  });

  test("our tag comes off a command; who the text tags is said by name and id", async () => {
    const users = new Map([
      [SELF, { id: SELF, username: "nouva" }],
      [OTHER, { id: OTHER, username: "nero" }],
    ]);
    const envelope = await envelopeOf({ content: `<@${SELF}> /approve <@${OTHER}>`, mentions: { users } });
    expect(envelope).toMatchObject({ text: `/approve <@${OTHER}>`, mentionsSelf: true, mentions: ["nouva", "nero", SELF, OTHER] });
  });

  test("a direct message is a dm, a group DM a group; no member is the author's username; a bot is marked", async () => {
    const dm = await envelopeOf({ channel: { type: ChannelType.DM }, member: null, author: { id: "6", username: "bob", bot: true } });
    const group = await envelopeOf({ channel: { type: ChannelType.GroupDM } });
    expect(dm).toMatchObject({ chatType: "dm", senderName: "bob", senderIsBot: true });
    expect(group!.chatType).toBe("group");
  });

  test("a reply carries what it replies to, even when that message cannot be read", async () => {
    expect((await envelopeOf({ reference: { messageId: "55" } }))!.replyTo).toBe("55");
  });

  test("a reply to this bot's own message says so; to anybody else's, or a link to ours, does not", async () => {
    const ours = await envelopeOf({ reference: { messageId: "55" }, mentions: { users: new Map(), repliedUser: { id: SELF } } });
    expect(ours!.repliesToSelf).toBe(true);
    // Not a mention: a reply pings its author, and that ping is not an address (`tagsUser`).
    expect(ours!.mentionsSelf).toBeUndefined();
    const theirs = await envelopeOf({ reference: { messageId: "55" }, mentions: { users: new Map(), repliedUser: { id: OTHER } } });
    expect(theirs!.repliesToSelf).toBeUndefined();
    expect((await envelopeOf({ mentions: { users: new Map(), repliedUser: { id: SELF } } }))!.repliesToSelf).toBeUndefined();
  });

  test("an attachment with no words is a message, with the attachment", async () => {
    const attachments = new Map([["a", { url: "https://cdn/x.png", name: "x.png", contentType: "image/png", size: 3 }]]);
    const envelope = await envelopeOf({ content: "", attachments });
    expect(envelope).toMatchObject({ text: "", attachments: [{ type: "image", url: "https://cdn/x.png" }] });
  });

  test("nothing said, nothing attached and nobody tagged is not a message", async () => {
    expect(await envelopeOf({ content: "  " })).toBeNull();
  });

  test("the collections discord.js may leave out are read as empty", async () => {
    expect(await envelopeOf({ attachments: undefined, mentions: undefined, client: { user: null } })).toMatchObject({ text: "halo", mentions: [] });
    expect(await envelopeOf({ mentions: {} })).toMatchObject({ text: "halo", mentions: [] });
  });
});

describe("stripLeadingSelfMention before the bot knows who it is", () => {
  test("strips nothing", () => {
    expect(stripLeadingSelfMention("<@undefined> hi", undefined)).toBe("<@undefined> hi");
  });
});
