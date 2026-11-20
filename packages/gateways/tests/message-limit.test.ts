/**
 * How long one message is, as each connection says it (`Gateway.maxMessageChars`): what a rewrite of a message is held
 * to, since an edit cuts a text that a send would part. Telegram's and Discord's own limits; a connection that parts
 * nothing says none.
 */

import { expect, test } from "bun:test";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";
import { TelegramGateway } from "../src/channels/telegram/gateway.ts";

test("Telegram and Discord say their one-message limit, the one their sends part a text at", () => {
  expect(new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling" }).maxMessageChars).toBe(4096);
  expect(new DiscordGateway({ id: "discord:main", platform: "discord", token: "t" }).maxMessageChars).toBe(2000);
});
