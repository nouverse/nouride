/**
 * What each platform calls a room (0.7.24) — `Gateway.roomTitle` — and a Discord thread's opening message.
 *
 * Discord: `#channel`, a thread by its own name, never the server's, nothing for a DM. Telegram: the group's title from
 * `getChat`, a forum topic by its own name once a message in it said it, nothing for a one-to-one. WhatsApp: the subject
 * the bridge put on the group's last message, nothing until it has.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import type { BridgeEvent } from "@nouride/shared";
import { discordRoomTitle, ThreadOpeners, type RoomChannel, type StarterMessage } from "../src/channels/discord/rooms.ts";
import { WhatsAppGateway, type BridgeChannel } from "../src/channels/whatsapp/gateway.ts";
import { startedTelegram } from "./telegram-harness.ts";
import { eventually } from "./wait.ts";

describe("Discord", () => {
  test("a channel is #name, a thread its own name, a DM nothing — and never a server's name", () => {
    expect(discordRoomTitle({ type: ChannelType.GuildText, name: "general" })).toBe("#general");
    expect(discordRoomTitle({ type: ChannelType.PublicThread, name: "Lampu teras", isThread: () => true, parent: { name: "rumah" } })).toBe("Lampu teras");
    expect(discordRoomTitle({ type: ChannelType.DM, name: "ann" })).toBeUndefined();
    expect(discordRoomTitle({ type: ChannelType.GroupDM, name: null })).toBeUndefined();
    expect(discordRoomTitle(null)).toBeUndefined();
  });

  function thread(starter: () => Promise<StarterMessage | null>): RoomChannel & { fetched: number } {
    const channel = {
      type: ChannelType.PublicThread,
      name: "Lampu teras",
      parent: { name: "rumah" },
      isThread: () => true,
      fetched: 0,
      fetchStarterMessage: async () => {
        channel.fetched++;
        return starter();
      },
    };
    return channel;
  }
  const STARTER: StarterMessage = { id: "700", content: "Lampu teras mati lagi", author: { id: "5", username: "mira_w" }, member: { displayName: "Mira" } };

  test("a message in a thread carries what the thread was started from, fetched once per thread", async () => {
    const openers = new ThreadOpeners();
    const channel = thread(async () => STARTER);
    expect(await openers.of("777", channel, "801")).toEqual({ senderId: "5", senderName: "Mira", text: "Lampu teras mati lagi", where: "#rumah" });
    expect(await openers.of("777", channel, "802")).toEqual({ senderId: "5", senderName: "Mira", text: "Lampu teras mati lagi", where: "#rumah" });
    expect(channel.fetched).toBe(1);
  });

  test("nothing outside a thread, for the starter itself, or for a thread whose starter is gone", async () => {
    const openers = new ThreadOpeners();
    expect(await openers.of("300", { type: ChannelType.GuildText, name: "general" }, "801")).toBeUndefined();
    // A forum post: its first message is the thread's starter, and has the thread's id.
    const forum = thread(async () => ({ ...STARTER, id: "777" }));
    expect(await openers.of("777", forum, "777")).toBeUndefined();
    expect(forum.fetched).toBe(0);

    const gone = thread(async () => {
      throw Object.assign(new Error("Unknown Message"), { code: 10008 });
    });
    expect(await openers.of("778", gone, "801")).toBeUndefined();
    expect(await openers.of("778", gone, "802")).toBeUndefined();
    expect(gone.fetched).toBe(1);
  });

  test("a fetch that failed for another reason is asked again with the next message", async () => {
    const openers = new ThreadOpeners();
    let fail = true;
    const flaky = thread(async () => {
      if (fail) throw new Error("socket hang up");
      return STARTER;
    });
    expect(await openers.of("779", flaky, "801")).toBeUndefined();
    fail = false;
    expect((await openers.of("779", flaky, "802"))?.text).toBe("Lampu teras mati lagi");
  });
});

describe("Telegram", () => {
  let restore: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await restore?.();
    restore = undefined;
  });

  test("a group's title from getChat; a one-to-one has none", async () => {
    const t = await startedTelegram((call) =>
      call.method === "getChat"
        ? { result: Number(call.payload.chat_id) < 0 ? { id: -100, type: "supergroup", title: "Keluarga Besar" } : { id: 42, type: "private", first_name: "Gading" } }
        : { result: true },
    );
    restore = t.restore;
    expect(await t.gateway.roomTitle("-100")).toBe("Keluarga Besar");
    expect(await t.gateway.roomTitle("42")).toBeUndefined();
    expect(t.called("getChat").map((call) => call.payload.chat_id)).toEqual(["-100", "42"]);
  });

  test("a forum topic by its own name, once a message in it said it", async () => {
    const t = await startedTelegram(() => ({ result: { id: -100, type: "supergroup", title: "Keluarga Besar", is_forum: true } }));
    restore = t.restore;
    expect(await t.gateway.roomTitle("-100:45")).toBe("Keluarga Besar");
    await t.update({
      message: {
        message_id: 9,
        date: 0,
        chat: { id: -100, type: "supergroup", title: "Keluarga Besar", is_forum: true },
        from: { id: 7, is_bot: false, first_name: "Mira" },
        message_thread_id: 45,
        is_topic_message: true,
        text: "lampu mati",
        reply_to_message: { message_id: 45, date: 0, chat: { id: -100, type: "supergroup" }, message_thread_id: 45, forum_topic_created: { name: "Rumah", icon_color: 0 } },
      },
    });
    expect(await t.gateway.roomTitle("-100:45")).toBe("Rumah");
  });
});

describe("WhatsApp", () => {
  test("the subject the bridge put on a group's message; nothing before it has", async () => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const channel: BridgeChannel = {
      writeLine: () => {},
      async *lines() {
        while (!done) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
      close: () => {
        done = true;
        wake?.();
      },
      closed: new Promise<void>(() => {}),
    };
    const push = (event: BridgeEvent) => {
      queue.push(JSON.stringify(event));
      wake?.();
    };
    const gateway = new WhatsAppGateway({ id: "whatsapp:main", platform: "whatsapp", sessionDir: "/tmp/wa", encryptionKey: "a".repeat(64), openChannel: () => channel });
    const got: unknown[] = [];
    gateway.onMessage((envelope) => got.push(envelope));
    await gateway.start();
    const message = { type: "message" as const, id: "m1", chatId: "1203@g.us", chatType: "group" as const, senderId: "62811@s.whatsapp.net", senderName: "Mira", text: "halo", timestamp: 1 };

    push(message);
    await eventually(() => got.length === 1, 2_000, "the first message");
    expect(await gateway.roomTitle("1203@g.us")).toBeUndefined();
    push({ ...message, id: "m2", chatTitle: "Keluarga Besar" });
    await eventually(() => got.length === 2, 2_000, "the second message");
    expect(await gateway.roomTitle("1203@g.us")).toBe("Keluarga Besar");
    await gateway.stop();
  });
});
