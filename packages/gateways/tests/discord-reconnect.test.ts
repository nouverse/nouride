/**
 * A Discord reconnect past a client that will not close, as it happened on the live box: the first login timed out,
 * the retry's `destroy()` of that client waited on a `close` that never came, and the gateway said "connecting" from
 * then on — the old client still taking messages in, with no client to answer them through. Once past it, the old
 * client finished its login a few seconds later, and stayed open beside the new one: nine sessions for six bots.
 */

import { afterEach, expect, spyOn, test } from "bun:test";
import { ChannelType, Client, Events } from "discord.js";
import type { MessageEnvelope } from "@nouride/shared";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";
import { eventually } from "./wait.ts";

const restores: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) await restore();
});

function message(id: string): Record<string, unknown> {
  return {
    id,
    partial: false,
    createdTimestamp: 1_700_000_000_000,
    editedTimestamp: null,
    channelId: "300",
    channel: { type: ChannelType.DM },
    author: { id: "5", username: "ann", bot: false },
    member: null,
    content: "still there?",
    attachments: new Map(),
    mentions: { users: new Map() },
    reference: null,
    client: { user: { id: "8888888888888888888" } },
  };
}

test("the retry connects past a client that never closes, only the new client takes messages in, and the old one is closed once it logs in", async () => {
  const clients: Client[] = [];
  const login = spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
    clients.push(this);
    if (clients.length === 1) throw new Error("login timed out");
    this.emit(Events.ClientReady, this as never);
    return "token";
  });
  const destroyed: Client[] = [];
  const destroy = spyOn(Client.prototype, "destroy").mockImplementation(function (this: Client) {
    destroyed.push(this);
    return this === clients[0] && destroyed.filter((client) => client === this).length === 1 ? new Promise<void>(() => {}) : Promise.resolve();
  });
  const gateway = new DiscordGateway({
    id: "discord:main",
    platform: "discord",
    token: "t",
    resilience: { healthCheckIntervalMs: 3_600_000, reconnectBackoffMs: 1, reconnectBackoffMaxMs: 2, teardownTimeoutMs: 20 },
  });
  restores.push(() => login.mockRestore(), () => destroy.mockRestore(), () => gateway.stop());
  const envelopes: MessageEnvelope[] = [];
  gateway.onMessage((envelope) => envelopes.push(envelope));
  await gateway.start();

  await eventually(() => gateway.status === "connected", 2_000, "the second client to connect");
  const [replaced, current] = clients;
  // The replaced client's first: both go the same way, so had it been taken in, it would be there before the other.
  replaced!.emit(Events.MessageCreate, message("901") as never);
  current!.emit(Events.MessageCreate, message("902") as never);
  await eventually(() => envelopes.some((envelope) => envelope.id === "902"), 2_000, "the current client's message");
  expect(envelopes.map((envelope) => envelope.id)).toEqual(["902"]);

  // Its login lands late, a second session for the same bot: closed then, and the current one left alone.
  replaced!.emit(Events.ClientReady, replaced as never);
  expect(destroyed.filter((client) => client === replaced)).toHaveLength(2);
  expect(destroyed).not.toContain(current);
  expect(gateway.status).toBe("connected");
});
