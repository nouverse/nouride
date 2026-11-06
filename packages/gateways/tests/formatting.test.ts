/**
 * Each adapter says how to write for its platform (`Gateway.formatting`) — the prompt's formatting line. The engine
 * switched on the platform's name for it until 0.7.11, which put Discord's 2000-character limit in the engine.
 */

import { describe, expect, test } from "bun:test";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";
import { TelegramGateway } from "../src/channels/telegram/gateway.ts";
import { WhatsAppGateway } from "../src/channels/whatsapp/gateway.ts";

describe("what each platform's agent is told about writing for it", () => {
  test("Discord: sent as written, no tables, split past 2000 characters", () => {
    const line = new DiscordGateway({ id: "discord:main", platform: "discord", token: "t" }).formatting;
    expect(line).toContain("Discord markdown, sent as written");
    expect(line).toContain("does not render tables");
    expect(line).toContain("2000 characters");
  });

  test("Telegram: markdown converted, a phone, no tables", () => {
    const line = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling" }).formatting;
    expect(line).toContain("converted before sending");
    expect(line).toContain("do not use tables");
  });

  test("WhatsApp: converted to its own marks, short", () => {
    const line = new WhatsAppGateway({
      id: "whatsapp:main",
      platform: "whatsapp",
      sessionDir: "/tmp/wa-session",
      encryptionKey: "a".repeat(64),
      agentId: "nouva",
      openChannel: () => ({}) as never,
    }).formatting;
    expect(line).toContain("converted to WhatsApp's own marks");
    expect(line).toContain("Keep replies short");
  });
});
