/**
 * Who a Telegram message addresses — and the bug that made a bot ignore its own username.
 *
 * Telegram addresses a bot by `@username`. The adapter handed that username to the router as a plain
 * mention and never said it was *this* bot, so the router matched `infrasecaxl_bot` against agent
 * names, found none, concluded somebody else was tagged, and dropped the message on every connection
 * — the tagged bot's included. Only an agent id typed in the text got an answer. Discord never had
 * this: its adapter has always set `mentionsSelf`.
 */

import { describe, expect, test } from "bun:test";
import { replyParameters } from "../src/channels/telegram/gateway.ts";
import { repliesToSelf, telegramMentions } from "../src/channels/telegram/envelope.ts";

const ME = { id: 777, username: "infrasecaxl_bot" };

function message(text: string, entities: { type: string; offset: number; length: number; user?: { id: number; username?: string } }[]) {
  return { text, entities } as never;
}

describe("telegram mentions", () => {
  test("its own @username is mentionsSelf, not a mention of someone else", () => {
    const result = telegramMentions(message("@infrasecaxl_bot woi", [{ type: "mention", offset: 0, length: 16 }]), ME);
    expect(result).toEqual({ mentions: [], mentionsSelf: true, text: "woi" });
  });

  test("case does not matter — Telegram usernames do not distinguish it", () => {
    const result = telegramMentions(message("@InfraSecAXL_Bot cek", [{ type: "mention", offset: 0, length: 16 }]), ME);
    expect(result.mentionsSelf).toBe(true);
  });

  test("another bot's username stays a mention of someone else", () => {
    const result = telegramMentions(message("@bosbosan_bot halo", [{ type: "mention", offset: 0, length: 13 }]), ME);
    expect(result).toEqual({ mentions: ["bosbosan_bot"], mentionsSelf: false, text: "@bosbosan_bot halo" });
  });

  test("a text_mention of this bot's account counts, even without a username in the text", () => {
    const result = telegramMentions(
      message("Infrasec tolong cek", [{ type: "text_mention", offset: 0, length: 8, user: { id: 777, username: "infrasecaxl_bot" } }]),
      ME,
    );
    expect(result.mentionsSelf).toBe(true);
    expect(result.mentions).toEqual([]);
  });

  test("only a leading tag of its own is stripped; one in the middle is left for the model to read", () => {
    const result = telegramMentions(
      message("tolong @infrasecaxl_bot cek log", [{ type: "mention", offset: 7, length: 16 }]),
      ME,
    );
    expect(result).toEqual({ mentions: [], mentionsSelf: true, text: "tolong @infrasecaxl_bot cek log" });
  });

  test("a bare tag leaves empty text and still says it was addressed", () => {
    const result = telegramMentions(message("@infrasecaxl_bot", [{ type: "mention", offset: 0, length: 16 }]), ME);
    expect(result).toEqual({ mentions: [], mentionsSelf: true, text: "" });
  });

  test("both bots tagged: this one is self, the other remains a mention", () => {
    const result = telegramMentions(
      message("@infrasecaxl_bot @bosbosan_bot sync", [
        { type: "mention", offset: 0, length: 16 },
        { type: "mention", offset: 17, length: 13 },
      ]),
      ME,
    );
    expect(result.mentionsSelf).toBe(true);
    expect(result.mentions).toEqual(["bosbosan_bot"]);
    expect(result.text).toBe("@bosbosan_bot sync");
  });

  test("a command addressed to this bot is ours, and reads as the bare command", () => {
    // What Telegram's own command menu writes in a group. No `mention` entity, so it was nobody's.
    const result = telegramMentions(message("/status@infrasecaxl_bot", [{ type: "bot_command", offset: 0, length: 23 }]), ME);
    expect(result).toEqual({ mentions: [], mentionsSelf: true, text: "/status" });
  });

  test("a command addressed to another bot is a mention of that bot", () => {
    const result = telegramMentions(message("/status@bosbosan_bot", [{ type: "bot_command", offset: 0, length: 20 }]), ME);
    expect(result).toEqual({ mentions: ["bosbosan_bot"], mentionsSelf: false, text: "/status@bosbosan_bot" });
  });

  test("a bare command addresses nobody", () => {
    const result = telegramMentions(message("/status", [{ type: "bot_command", offset: 0, length: 7 }]), ME);
    expect(result).toEqual({ mentions: [], mentionsSelf: false, text: "/status" });
  });

  test("before the bot knows its own identity nothing is self", () => {
    const result = telegramMentions(message("@infrasecaxl_bot woi", [{ type: "mention", offset: 0, length: 16 }]), undefined);
    expect(result).toEqual({ mentions: ["infrasecaxl_bot"], mentionsSelf: false, text: "@infrasecaxl_bot woi" });
  });
});

describe("answering a message that is gone", () => {
  test("the quote never costs the answer: Telegram sends it even if the quoted message was deleted", () => {
    expect(replyParameters("42")).toEqual({ message_id: 42, allow_sending_without_reply: true });
  });

  test("an id that is not Telegram's is not quoted at all", () => {
    // An internal handover carries the engine's own id; there is no message behind it on this bot.
    expect(replyParameters("msg_c7171fe9")).toBeUndefined();
  });
});

describe("a reply to this bot's own message", () => {
  // Live (2026-10-21): a reply to an agent's answer went unanswered in a group that needs a mention, once the record of
  // who wrote the answer was gone. Telegram hands the replied message over whole, its author included.
  test("says so; a reply to anybody else's does not", () => {
    expect(repliesToSelf({ reply_to_message: { message_id: 5, from: { id: 777 } } } as never, ME)).toBe(true);
    expect(repliesToSelf({ reply_to_message: { message_id: 5, from: { id: 42 } } } as never, ME)).toBe(false);
    expect(repliesToSelf({} as never, ME)).toBe(false);
  });

  test("a topic our bot opened does not make every message in it a reply to us", () => {
    // In a forum each message of a topic carries the topic's opening service message as `reply_to_message`.
    const opening = { message_id: 9, from: { id: 777 }, forum_topic_created: { name: "Deploy" } };
    expect(repliesToSelf({ reply_to_message: opening } as never, ME)).toBe(false);
  });
});
