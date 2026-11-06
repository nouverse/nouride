/**
 * A reply's quoted message is context, not text.
 *
 * The gateways learned to include it so the model has what a reply points at, and did it by
 * prepending `> [Name]: …` to `envelope.text`. That field is what the engine's command parser, its
 * slash-command queue bypass and its mention router all read — so replying to the approval prompt
 * with `/approve`, the obvious way to answer one, stopped being a command at all, and a quoted
 * `@othername` rerouted the reply to whoever it named.
 *
 * It rides on its own field now. These tests pin the boundary at the gateway, where it is decided.
 */

import { describe, expect, test } from "bun:test";
import type { Message as TelegramMessage } from "grammy/types";
import { quotedContext } from "../src/channels/telegram/envelope.ts";

function replied(over: Record<string, unknown> = {}): TelegramMessage {
  return {
    message_id: 2,
    date: 0,
    chat: { id: 1, type: "private" },
    text: "/approve",
    reply_to_message: {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" },
      from: { id: 9, is_bot: true, first_name: "Nouva" },
      text: "Waiting on you before I run exec.",
    },
    ...over,
  } as unknown as TelegramMessage;
}

describe("telegram quotedContext", () => {
  test("returns the quote and its author without touching the body", () => {
    expect(quotedContext(replied())).toEqual({
      quotedText: "Waiting on you before I run exec.",
      quotedSender: "Nouva",
    });
  });

  test("nothing for a message that is not a reply", () => {
    expect(quotedContext(replied({ reply_to_message: undefined }))).toEqual({});
  });

  test("nothing when the quoted message carries no text", () => {
    // A reply to a bare photo. An empty quote block would be noise in the prompt.
    const message = replied();
    (message as { reply_to_message?: Record<string, unknown> }).reply_to_message = {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" },
      from: { id: 9, is_bot: false, first_name: "Gading" },
    };
    expect(quotedContext(message)).toEqual({});
  });

  test("a caption counts as the quoted text", () => {
    const message = replied();
    (message as { reply_to_message?: Record<string, unknown> }).reply_to_message = {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" },
      from: { id: 9, is_bot: false, username: "gading" },
      caption: "the build is red",
    };
    expect(quotedContext(message)).toEqual({ quotedText: "the build is red", quotedSender: "gading" });
  });

  test("no author is left off rather than reported as unknown", () => {
    // A channel post has no `from`. "unknown" in the prompt reads as a participant called unknown.
    const message = replied();
    (message as { reply_to_message?: Record<string, unknown> }).reply_to_message = {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "channel" },
      text: "deploy finished",
    };
    expect(quotedContext(message)).toEqual({ quotedText: "deploy finished" });
  });
});
