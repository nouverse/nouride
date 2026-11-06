/**
 * A person's edit on Discord (G11): `messageUpdate`, which discord.js emits for a message it never cached only with the
 * message partial on, handed to the engine as the edit it is. Discord updates a message for more than an edit — an embed
 * loading for a link — and only an edit moves `editedTimestamp`: a message never edited is not one.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ChannelType, Client, Events, Partials } from "discord.js";
import type { MessageEnvelope } from "@nouride/shared";
import { discordEdit } from "../src/channels/discord/envelope.ts";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";
import { eventually } from "./wait.ts";

const SELF = "8888888888888888888";

function updated(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "900",
    partial: false,
    createdTimestamp: 1_700_000_000_000,
    editedTimestamp: 1_700_000_090_000,
    channelId: "300",
    channel: { type: ChannelType.GuildText },
    author: { id: "5", username: "ann", bot: false },
    member: { displayName: "Ann" },
    content: "deploy to staging",
    attachments: new Map(),
    mentions: { users: new Map() },
    reference: null,
    client: { user: { id: SELF } },
    ...over,
  };
}

const edit = (over: Record<string, unknown> = {}) => discordEdit(updated(over) as never, "discord:main");

describe("an updated message", () => {
  test("edited by its author is an edit: what it says now, the message it changes, when that was sent, an id of its own", async () => {
    const envelope = await edit();
    const { raw: _raw, ...rest } = envelope!;
    expect(rest).toEqual({
      id: "900:edited:1700000090000",
      timestamp: 1_700_000_090_000,
      gateway: "discord",
      gatewayId: "discord:main",
      chatId: "300",
      chatType: "channel",
      senderId: "5",
      senderName: "Ann",
      text: "deploy to staging",
      mentions: [],
      edit: { of: "900", sentAt: 1_700_000_000_000 },
    });
  });

  test("an edit that now tags this bot addresses it, its tag off the front", async () => {
    const users = new Map([[SELF, { id: SELF, username: "nouva" }]]);
    expect(await edit({ content: `<@${SELF}> lunch?`, mentions: { users } })).toMatchObject({ text: "lunch?", mentionsSelf: true });
  });

  test("words only: a file on the message is not sent again", async () => {
    const attachments = new Map([["a", { url: "https://cdn/x.png", name: "x.png", contentType: "image/png", size: 3 }]]);
    const envelope = await edit({ content: "the right caption", attachments });
    expect(envelope?.text).toBe("the right caption");
    expect(envelope?.attachments).toBeUndefined();
  });

  test("never edited — an embed loading for a link — is not an edit; nor a bot's, a partial one, or one left with no words", async () => {
    expect(await edit({ editedTimestamp: null })).toBeNull();
    expect(await edit({ author: { id: "6", username: "ci", bot: true } })).toBeNull();
    expect(await edit({ partial: true })).toBeNull();
    expect(await edit({ content: `<@${SELF}>`, mentions: { users: new Map([[SELF, { id: SELF, username: "nouva" }]]) } })).toBeNull();
  });
});

describe("the client the gateway builds", () => {
  const restores: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const restore of restores.splice(0)) await restore();
  });

  test("keeps the message partial, so an uncached message's edit is emitted — and hands the edit to the engine", async () => {
    const login = spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
      this.emit(Events.ClientReady, this as never);
      return "token";
    });
    const gateway = new DiscordGateway({ id: "discord:main", platform: "discord", token: "t", resilience: { healthCheckIntervalMs: 3_600_000 } });
    restores.push(() => login.mockRestore(), () => gateway.stop());
    const envelopes: MessageEnvelope[] = [];
    gateway.onMessage((envelope) => envelopes.push(envelope));
    await gateway.start();

    const client = (gateway as unknown as { client: Client }).client;
    expect(client.options.partials).toContain(Partials.Message);
    client.emit(Events.MessageUpdate, {} as never, updated() as never);
    await eventually(() => envelopes.length === 1, 2_000, "the edit handed over");
    expect(envelopes[0]).toMatchObject({ id: "900:edited:1700000090000", edit: { of: "900" } });
    // An update that is not an edit is not handed over.
    client.emit(Events.MessageUpdate, {} as never, updated({ id: "901", editedTimestamp: null }) as never);
    client.emit(Events.MessageCreate, updated({ id: "902", editedTimestamp: null }) as never);
    await eventually(() => envelopes.length === 2, 2_000, "the next message handed over");
    expect(envelopes.map((envelope) => envelope.id)).toEqual(["900:edited:1700000090000", "902"]);
  });
});
