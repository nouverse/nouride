/**
 * What each platform says when it will never take a message (`refusal` in each adapter): a refusal is thrown to the
 * caller instead of buffered (`commons/resilience.ts`). Everything else stays worth a retry — a rate limit, a lost
 * connection, a formatting refusal that plain text answers.
 */

import { describe, expect, test } from "bun:test";
import { GrammyError } from "grammy";
import { discordRefusal } from "../src/channels/discord/gateway.ts";
import { telegramRefusal } from "../src/channels/telegram/gateway.ts";

const telegram = (code: number, description: string) => new GrammyError(description, { ok: false, error_code: code, description }, "sendMessage", {});

describe("Telegram", () => {
  test("a 403, and a 400 naming a chat, person or right that is not there, are final — in Telegram's words", () => {
    expect(telegramRefusal(telegram(403, "Forbidden: the bot can't send messages to the bot"))).toBe("Forbidden: the bot can't send messages to the bot");
    expect(telegramRefusal(telegram(403, "Forbidden: bot was blocked by the user"))).toBe("Forbidden: bot was blocked by the user");
    expect(telegramRefusal(telegram(400, "Bad Request: chat not found"))).toBe("Bad Request: chat not found");
    expect(telegramRefusal(telegram(400, "Bad Request: not enough rights to send text messages to the chat"))).not.toBeNull();
  });

  test("a rate limit, a formatting refusal and a network failure are not", () => {
    expect(telegramRefusal(telegram(429, "Too Many Requests: retry after 3"))).toBeNull();
    expect(telegramRefusal(telegram(400, "Bad Request: can't parse entities: unsupported start tag"))).toBeNull();
    expect(telegramRefusal(new Error("fetch failed"))).toBeNull();
  });
});

describe("Discord", () => {
  const api = (code: number | string, message: string) => Object.assign(new Error(message), { code });

  test("no access, no such channel or person, a person who takes no DMs from this bot: final", () => {
    expect(discordRefusal(api(50007, "Cannot send messages to this user"))).toBe("Cannot send messages to this user");
    expect(discordRefusal(api(50001, "Missing Access"))).toBe("Missing Access");
    expect(discordRefusal(api(10003, "Unknown Channel"))).toBe("Unknown Channel");
  });

  test("anything else is worth another try — a bad body, a token, a network failure", () => {
    expect(discordRefusal(api(50035, "Invalid Form Body"))).toBeNull();
    expect(discordRefusal(api("TokenInvalid", "An invalid token was provided."))).toBeNull();
    expect(discordRefusal(new Error("socket hang up"))).toBeNull();
  });
});
