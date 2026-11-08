/**
 * Buttons on Discord: a row of components under the last part of a message, a press — a button interaction —
 * handed to the engine and its answer carried out inside Discord's three seconds, and a message settled with its
 * components taken away.
 */

import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { ButtonStyle, ChannelType, Client, ComponentType, Events, MessageFlags } from "discord.js";
import { createLogger, type ButtonPress, type MessageButton, type OutboundMessage, type PressAnswer } from "@nouride/shared";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";
import { buttonRow, carryOut, discordPress } from "../src/channels/discord/presses.ts";
import { eventually } from "./wait.ts";

const BUTTONS: MessageButton[] = [
  { label: "Approve", data: "approval:once:apr_1", style: "positive" },
  { label: "Always", data: "approval:always:apr_1" },
  { label: "Deny", data: "approval:deny:apr_1", style: "negative" },
];

const ROW = [
  {
    type: ComponentType.ActionRow,
    components: [
      { type: ComponentType.Button, style: ButtonStyle.Success, label: "Approve", custom_id: "approval:once:apr_1" },
      { type: ComponentType.Button, style: ButtonStyle.Secondary, label: "Always", custom_id: "approval:always:apr_1" },
      { type: ComponentType.Button, style: ButtonStyle.Danger, label: "Deny", custom_id: "approval:deny:apr_1" },
    ],
  },
];

/** A Discord gateway whose channel `42` records what is sent to it and what its messages are edited to. */
function withChannel(o: { editFails?: boolean } = {}) {
  const discord = new DiscordGateway({ id: "discord:main", platform: "discord", token: "t" });
  const sent: Record<string, unknown>[] = [];
  const edits: Record<string, unknown>[] = [];
  const channel = {
    isTextBased: () => true,
    send: async (options: Record<string, unknown>) => (sent.push(options), { id: String(sent.length) }),
    messages: {
      fetch: async () => ({
        edit: async (options: Record<string, unknown>) => {
          if (o.editFails) throw new Error("Unknown Message");
          edits.push(options);
        },
      }),
    },
  };
  (discord as unknown as { client: unknown }).client = { channels: { cache: new Map([["42", channel]]), fetch: async () => channel } };
  const deliver = (msg: OutboundMessage) => (discord as unknown as { deliver(m: OutboundMessage): Promise<string[]> }).deliver(msg);
  return { discord, deliver, sent, edits };
}

/** A press on message 7, as discord.js hands one over — recording how it was answered. */
function interaction(over: Record<string, unknown> = {}) {
  const answered: [string, unknown][] = [];
  const record = (how: string) => async (options?: unknown) => void answered.push([how, options]);
  return {
    answered,
    interaction: {
      isButton: () => true,
      isChatInputCommand: () => false,
      inGuild: () => true,
      channelId: "42",
      channel: { type: ChannelType.GuildText },
      message: { id: "7" },
      customId: "approval:once:apr_1",
      user: { id: "5", username: "ann" },
      member: { displayName: "Ann" },
      update: record("update"),
      reply: record("reply"),
      followUp: record("followUp"),
      deferUpdate: record("deferUpdate"),
      editReply: record("editReply"),
      ...over,
    },
  };
}

const log = createLogger("test.discord-buttons");

describe("a message with buttons", () => {
  test("carries them as one row of components, a yes green and a no red — on its last part only; the adapter says it can", async () => {
    const { discord, deliver, sent } = withChannel();
    expect(discord.buttons).toBe(true);
    await deliver({ gatewayId: "discord:main", chatId: "42", text: "approve?", buttons: BUTTONS });
    expect(sent.map((options) => options.components)).toEqual([ROW]);
    expect(buttonRow(BUTTONS)).toEqual(ROW);

    await deliver({ gatewayId: "discord:main", chatId: "42", text: `${"a".repeat(1_900)}\n\n${"b".repeat(500)}`, buttons: BUTTONS });
    expect(sent.slice(1).map((options) => options.components)).toEqual([undefined, ROW]);
  });

  test("six buttons are two rows: Discord takes at most five in a row, and refuses the message otherwise", () => {
    // A mission's question carries up to six answers as buttons (`missions/options.ts`), one row on Telegram. Sent to
    // Discord as one row of six, the whole message was refused ("Must be 5 or fewer in length") — the question too.
    const six: MessageButton[] = Array.from({ length: 6 }, (_, i) => ({ label: `Option ${i + 1}`, data: `mission:answer:msn_1:k:${i}` }));
    const rows = buttonRow(six);
    expect(rows.map((row) => row.components.length)).toEqual([5, 1]);
    expect(rows.flatMap((row) => row.components.map((button) => button.custom_id))).toEqual(six.map((button) => button.data));
    expect(buttonRow(BUTTONS)).toHaveLength(1);
  });

  test("is settled by rewriting it with no components, pinging nobody — and says so when it cannot be", async () => {
    const { discord, edits } = withChannel();
    expect(await discord.settleButtons("42", "7", "✅ Approved by Ann")).toBe(true);
    expect(edits).toEqual([{ content: "✅ Approved by Ann", components: [], allowedMentions: { parse: [] } }]);
    expect(await withChannel({ editFails: true }).discord.settleButtons("42", "7", "x")).toBe(false);
  });

  test("said again with its buttons kept, for a question still open (0.8.7: how many wait behind it)", async () => {
    const { discord, edits } = withChannel();
    expect(await discord.settleButtons("42", "7", "⏸ waiting\n_One more question is waiting behind this one._", BUTTONS)).toBe(true);
    expect(edits).toEqual([{ content: "⏸ waiting\n_One more question is waiting behind this one._", components: ROW, allowedMentions: { parse: [] } }]);
  });
});

describe("a press", () => {
  test("is read as the press it is: in a server a channel, outside one a DM, the presser by their name there", () => {
    expect(discordPress(interaction().interaction as never, "discord:main")).toEqual({
      gatewayId: "discord:main",
      chatId: "42",
      chatType: "channel",
      messageId: "7",
      data: "approval:once:apr_1",
      senderId: "5",
      senderName: "Ann",
    });
    expect(discordPress(interaction({ inGuild: () => false, channel: null, member: null }).interaction as never, "discord:main")).toMatchObject({ chatType: "dm", senderName: "ann" });
  });

  test("settled: the message is rewritten in the acknowledgement itself, and the notice goes to the presser alone", async () => {
    const { interaction: pressed, answered } = interaction();
    await carryOut(pressed as never, Promise.resolve({ notice: "Approved.", settled: "✅ Approved by Ann" }), log);
    expect(answered).toEqual([
      ["update", { content: "✅ Approved by Ann", components: [], allowedMentions: { parse: [] } }],
      ["followUp", { content: "Approved.", flags: MessageFlags.Ephemeral }],
    ]);
  });

  test("refused: the notice to the presser alone, and the message as it was; with nothing to say, acknowledged", async () => {
    const refused = interaction();
    await carryOut(refused.interaction as never, Promise.resolve({ notice: "Only the person who asked, or an admin, can answer this one." }), log);
    expect(refused.answered).toEqual([["reply", { content: "Only the person who asked, or an admin, can answer this one.", flags: MessageFlags.Ephemeral }]]);

    const quiet = interaction();
    await carryOut(quiet.interaction as never, Promise.resolve({}), log);
    expect(quiet.answered.map(([how]) => how)).toEqual(["deferUpdate"]);
  });

  test("an answer slower than Discord's three seconds is acknowledged first, and carried out after", async () => {
    jest.useFakeTimers();
    try {
      const { interaction: pressed, answered } = interaction();
      let answer: (value: PressAnswer) => void = () => {};
      const done = carryOut(pressed as never, new Promise<PressAnswer>((resolve) => (answer = resolve)), log);
      jest.advanceTimersByTime(2_500);
      await Promise.resolve();
      await Promise.resolve();
      expect(answered.map(([how]) => how)).toEqual(["deferUpdate"]);
      answer({ notice: "Approved.", settled: "✅ Approved by Ann" });
      await done;
      expect(answered).toEqual([
        ["deferUpdate", undefined],
        ["editReply", { content: "✅ Approved by Ann", components: [], allowedMentions: { parse: [] } }],
        ["followUp", { content: "Approved.", flags: MessageFlags.Ephemeral }],
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("one Discord will no longer take an answer for — expired — ends quietly", async () => {
    const { interaction: pressed } = interaction({
      update: async () => {
        throw new Error("Unknown interaction");
      },
    });
    await carryOut(pressed as never, Promise.resolve({ settled: "x" }), log);
  });
});

describe("the client the gateway builds", () => {
  const restores: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const restore of restores.splice(0)) await restore();
  });

  test("hands a button interaction to the engine and carries its answer out", async () => {
    const login = spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
      this.emit(Events.ClientReady, this as never);
      return "token";
    });
    const gateway = new DiscordGateway({ id: "discord:main", platform: "discord", token: "t", resilience: { healthCheckIntervalMs: 3_600_000 } });
    restores.push(() => login.mockRestore(), () => gateway.stop());
    const presses: ButtonPress[] = [];
    gateway.onPress(async (press) => (presses.push(press), { settled: "✅ Approved by Ann" }));
    await gateway.start();

    const client = (gateway as unknown as { client: Client }).client;
    const { interaction: pressed, answered } = interaction();
    client.emit(Events.InteractionCreate, pressed as never);
    await eventually(() => answered.length === 1, 2_000, "the press answered");
    expect(presses.map((press) => press.data)).toEqual(["approval:once:apr_1"]);
    expect(answered[0]?.[0]).toBe("update");
  });
});
