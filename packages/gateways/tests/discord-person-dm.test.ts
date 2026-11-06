/**
 * A person's one-to-one on Discord, addressed by their account (0.8.0): their user id names no channel, so the gateway
 * opens their DM and sends there. The morning line and `send_message` address a person by account, and Discord answered
 * Unknown Channel — on the live box the owner's morning line fell through to Telegram. An id that is nobody's is still
 * refused, in Discord's own words.
 */

import { expect, test } from "bun:test";
import type { OutboundMessage } from "@nouride/shared";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";

const unknownChannel = () => Object.assign(new Error("Unknown Channel"), { code: 10003 });

function gateway(people: Record<string, { sent: unknown[] }>) {
  const discord = new DiscordGateway({ id: "discord:main", platform: "discord", token: "t" });
  const dm = (sent: unknown[]) => ({ isTextBased: () => true, send: async (options: unknown) => (sent.push(options), { id: String(sent.length) }) });
  (discord as unknown as { client: unknown }).client = {
    channels: { cache: new Map(), fetch: async () => Promise.reject(unknownChannel()) },
    users: {
      fetch: async (id: string) => (people[id] ? { createDM: async () => dm(people[id]!.sent) } : Promise.reject(Object.assign(new Error("Unknown User"), { code: 10013 }))),
    },
  };
  return (msg: OutboundMessage) => (discord as unknown as { deliver(m: OutboundMessage): Promise<string[]> }).deliver(msg);
}

test("an account's id opens that person's DM, and the message goes there", async () => {
  const gading = { sent: [] as unknown[] };
  const deliver = gateway({ "214": gading });
  await deliver({ chatId: "214", text: "☀ Since yesterday morning: 1 mission finished" } as OutboundMessage);
  expect(gading.sent).toHaveLength(1);
  expect(JSON.stringify(gading.sent[0])).toContain("Since yesterday morning");
});

test("an id that is neither a channel nor a person is refused as Discord said it", async () => {
  const deliver = gateway({});
  await expect(deliver({ chatId: "999", text: "x" } as OutboundMessage)).rejects.toThrow("Unknown Channel");
});
