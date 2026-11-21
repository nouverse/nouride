/**
 * A sender let in ahead by what a person can write down: a phone number on WhatsApp, an id or a username on Telegram
 * and Discord. Each connection reads the written form its own way (`Gateway.senderIdOf`), and each message carries
 * the sender's other id beside the one it arrives under (`MessageEnvelope.senderAlso`), so the two meet at the door.
 *
 * WhatsApp delivers most people under a hidden id (`…@lid`), not their number: a list of ten thousand numbers let in
 * ahead would have matched nobody.
 */

import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";
import { discordEnvelope, discordSenderId, handleAlso } from "../src/channels/discord/envelope.ts";
import { TelegramGateway } from "../src/channels/telegram/gateway.ts";
import { telegramEnvelope, usernameAlso } from "../src/channels/telegram/envelope.ts";
import { whatsappEnvelope, whatsappSenderId } from "../src/channels/whatsapp/envelope.ts";

describe("WhatsApp", () => {
  test("a number with its country code, however it is written, is WhatsApp's address of it", () => {
    for (const written of ["6281234567890", "+62 812-3456-7890", " +62 (812) 3456.7890 ", "62 812 3456 7890"]) expect(whatsappSenderId(written)).toBe("6281234567890@s.whatsapp.net");
    expect(whatsappSenderId("14155550123")).toBe("14155550123@s.whatsapp.net");
    // WhatsApp's own addresses as they are.
    expect(whatsappSenderId("6281234567890@s.whatsapp.net")).toBe("6281234567890@s.whatsapp.net");
    expect(whatsappSenderId("100000000000001@lid")).toBe("100000000000001@lid");
  });

  test("the local way from 0, too few or too many digits, and words are nobody's", () => {
    for (const written of ["081234567890", "0812-3456-7890", "1234567", "1234567890123456", "phone", "sam@example.com", "+62 812 abc", "", "120363000000000001@g.us"]) expect(whatsappSenderId(written)).toBeNull();
  });

  test("a message under a hidden id carries the number beside it, and one with none carries nothing", () => {
    const event = { type: "message" as const, id: "M1", chatId: "100000000000001@lid", chatType: "dm" as const, senderId: "100000000000001@lid", senderName: "Mira", text: "halo", timestamp: 1 };
    const self = { gatewayId: "whatsapp:main" };
    expect(whatsappEnvelope({ ...event, senderAlso: ["6281234567890@s.whatsapp.net"] }, self)).toMatchObject({ senderId: "100000000000001@lid", senderAlso: ["6281234567890@s.whatsapp.net"] });
    expect("senderAlso" in whatsappEnvelope(event, self)!).toBe(false);
    expect("senderAlso" in whatsappEnvelope({ ...event, senderAlso: [] }, self)!).toBe(false);
  });
});

describe("Telegram", () => {
  const gateway = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling" });

  test("an account's id as it is; its username, however it is written, as @name in lower case", () => {
    expect(gateway.senderIdOf("5550001111")).toBe("5550001111");
    for (const written of ["@Sam_Lee", "sam_lee", "t.me/Sam_Lee", "https://t.me/sam_lee", " @sam_lee "]) expect(gateway.senderIdOf(written)).toBe("@sam_lee");
  });

  test("a phone number, a name too short and a name that is no username are nobody's: a bot is shown no number", () => {
    for (const written of ["+62 812 3456 7890", "@abc", "sam lee", "1sam_lee", "sam-lee", ""]) expect(gateway.senderIdOf(written)).toBeNull();
  });

  test("a message carries its sender's username beside the id, lower case, and none where they have none", () => {
    const from = { id: 5550001111, is_bot: false, first_name: "Sam" };
    const message = (more: Record<string, unknown>) => ({ message_id: 1, date: 1_700_000_000, chat: { id: 5550001111, type: "private" }, text: "halo", from: { ...from, ...more } }) as never;
    const self = { gatewayId: "telegram:main", me: { id: 1, username: "bot" } };
    expect(telegramEnvelope(message({ username: "Sam_Lee" }), self)).toMatchObject({ senderId: "5550001111", senderAlso: ["@sam_lee"] });
    expect("senderAlso" in telegramEnvelope(message({}), self)!).toBe(false);
    expect(usernameAlso(undefined)).toEqual({});
  });
});

describe("Discord", () => {
  test("an account's id as it is; its username as @name in lower case; digits too short to be an id, and words, nobody's", () => {
    const gateway = new DiscordGateway({ id: "discord:main", platform: "discord", token: "t" });
    expect(gateway.senderIdOf("1111111111111111111")).toBe("1111111111111111111");
    for (const written of ["Sam.Lee", "@sam.lee", " sam.lee "]) expect(discordSenderId(written)).toBe("@sam.lee");
    for (const written of ["12345", "sam lee", "sam#1234", "s", ""]) expect(discordSenderId(written)).toBeNull();
  });

  test("a message carries its sender's username beside the id, only where Discord holds that name for one account", async () => {
    const message = (author: Record<string, unknown>) =>
      ({ id: "900", createdTimestamp: 1_700_000_000_000, channelId: "300", channel: { type: ChannelType.DM }, author: { id: "5", bot: false, ...author }, member: null, content: "halo", attachments: new Map(), mentions: { users: new Map() }, reference: null, client: { user: { id: "8888888888888888888" } }, fetchReference: async () => { throw new Error("gone"); } }) as never;
    expect(await discordEnvelope(message({ username: "Sam.Lee", discriminator: "0" }), "discord:main")).toMatchObject({ senderId: "5", senderAlso: ["@sam.lee"] });
    // An older `name#1234` account shares its name with others: a name several hold lets nobody in.
    expect(handleAlso({ username: "sam", discriminator: "1234" })).toEqual({});
    expect(handleAlso({ username: "sam" })).toEqual({ senderAlso: ["@sam"] });
  });
});
