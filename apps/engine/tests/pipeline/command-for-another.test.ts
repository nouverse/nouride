/**
 * `commandForAnotherBot`: a command with the tag of another of our bots in front is that bot's, and the copies of
 * the other bots leave it alone. The rule alone, case by case; what it does in a room of several bots is in
 * `room-mention.test.ts` ("on Discord").
 */

import { describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "@nouride/shared";
import { commandForAnotherBot } from "@/modules/pipeline/command-for-another.ts";
import { envelope } from "../helpers.ts";

const hooks = { has: (command: string) => ["/status", "/mention"].includes(command) };
const DISCORD = { "discord:lead": "<@111>", "discord:nox": "<@222>", "discord:nero": "<@333>" };
const TELEGRAM = { "telegram:lead": "@lead_bot", "telegram:nox": "@Nox_Bot" };
const tags = (platform: MessageEnvelope["gateway"]) => (platform === "discord" ? DISCORD : platform === "telegram" ? TELEGRAM : {});

/** One copy of a message in a Discord channel, as the bot of `connection` is handed it. */
const onDiscord = (connection: string, text: string, over: Partial<MessageEnvelope> = {}) =>
  commandForAnotherBot({ hooks, tags }, envelope({ gateway: "discord", gatewayId: connection, chatType: "channel", text, ...over }));

describe("a command with another bot's tag in front", () => {
  test("is that bot's: every other copy leaves it", () => {
    expect(onDiscord("discord:lead", "<@222> /status")).toBe(true);
    expect(onDiscord("discord:nero", "<@222> /status")).toBe(true);
    expect(onDiscord("discord:nero", "  <@222>   /mention required")).toBe(true);
  });

  test("on the named bot's own copy the tag is off and it is a command like any", () => {
    expect(onDiscord("discord:nox", "/status", { mentionsSelf: true })).toBe(false);
  });

  test("both of Discord's spellings of a tag, and a handle in any case", () => {
    expect(onDiscord("discord:lead", "<@!222> /status")).toBe(true);
    expect(commandForAnotherBot({ hooks, tags }, envelope({ gateway: "telegram", gatewayId: "telegram:lead", chatType: "group", text: "@nox_bot /status" }))).toBe(true);
  });

  test("a bot the words tag later, as what the command is about, leaves it too", () => {
    // `@Lead /mention @Nox` on Nox's copy: tagged, but by the argument. Its own tag is still in the words.
    expect(onDiscord("discord:nox", "<@111> /mention <@222>", { mentionsSelf: true })).toBe(true);
  });

  test("addressed here as well, this bot's tag taken off the front by its adapter: left as it was", () => {
    // `@Lead @Nox /status` on Lead's copy: what is left leads with Nox's tag, and Lead was tagged with no tag left.
    expect(onDiscord("discord:lead", "<@222> /status", { mentionsSelf: true })).toBe(false);
    // And on Nox's copy the run of tags in front holds its own.
    expect(onDiscord("discord:nox", "<@111> <@222> /status", { mentionsSelf: true })).toBe(false);
  });

  test("only a command we have, and only after the tag", () => {
    expect(onDiscord("discord:lead", "<@222> hello there")).toBe(false);
    expect(onDiscord("discord:lead", "<@222> /etc/hosts looks odd")).toBe(false);
    expect(onDiscord("discord:lead", "<@222>")).toBe(false);
    expect(onDiscord("discord:lead", "/status <@222>")).toBe(false);
  });

  test("only the tags of our own bots: a name, a person and a stranger's bot are not that", () => {
    expect(onDiscord("discord:lead", "nox: /status")).toBe(false);
    expect(onDiscord("discord:lead", "@nox /status")).toBe(false);
    expect(onDiscord("discord:lead", "<@999> /status")).toBe(false);
  });

  test("never in a DM, and never a bot's own message", () => {
    expect(onDiscord("discord:lead", "<@222> /status", { chatType: "dm" })).toBe(false);
    expect(onDiscord("discord:lead", "<@222> /status", { senderIsBot: true })).toBe(false);
  });
});
