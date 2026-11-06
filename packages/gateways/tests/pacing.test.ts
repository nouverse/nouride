/**
 * How each platform's connection reconnects is its adapter's own since 0.8.0: a gateway's `[resilience]` table in
 * `config.toml` set it until then, and nobody tuned it. WhatsApp keeps the slower pacing the engine used to hand it.
 */

import { describe, expect, test } from "bun:test";
import type { GatewayResilienceConfig } from "@nouride/shared";
import { WhatsAppGateway } from "../src/channels/whatsapp/gateway.ts";
import { TelegramGateway } from "../src/channels/telegram/gateway.ts";

function pacing(gateway: unknown): GatewayResilienceConfig {
  return (gateway as { resilience: GatewayResilienceConfig }).resilience;
}

const whatsapp = (resilience?: Partial<GatewayResilienceConfig>) =>
  new WhatsAppGateway({
    id: "whatsapp:main",
    platform: "whatsapp",
    sessionDir: "/tmp/wa-pacing",
    encryptionKey: "a".repeat(64),
    ...(resilience ? { resilience } : {}),
    openChannel: () => {
      throw new Error("not started in this test");
    },
  });

describe("a connection's reconnect pacing", () => {
  test("WhatsApp's: fewer attempts, further apart — its login is the flakiest", () => {
    expect(pacing(whatsapp())).toMatchObject({ maxReconnectAttempts: 5, reconnectBackoffMs: 2000, reconnectBackoffMaxMs: 120_000, reconnectBackoffMultiplier: 2, healthCheckIntervalMs: 30_000 });
  });

  test("Telegram's is every platform's", () => {
    const gateway = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling" });
    expect(pacing(gateway)).toMatchObject({ maxReconnectAttempts: 10, reconnectBackoffMs: 1000, reconnectBackoffMaxMs: 60_000 });
  });

  test("a test's own pacing still goes over WhatsApp's", () => {
    expect(pacing(whatsapp({ reconnectBackoffMs: 1 }))).toMatchObject({ maxReconnectAttempts: 5, reconnectBackoffMs: 1 });
  });
});
