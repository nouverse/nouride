/**
 * Rooms get names (0.7.24), through a real pipeline: a group message asks its platform what the room is called and the
 * answer is kept; `send_message` takes a group by that name or by the operator's rename — never by a memory file's name;
 * the agent is told the room's name; the Groups page's list and rename; and a thread's first question carries the
 * message the thread was started from, once.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MessageEnvelope, ToolContext } from "@nouride/shared";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { RoomNameStore } from "@/modules/rooms/room-names.store.ts";
import { resolveSendTarget } from "@/modules/tools/builtins/send-message.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

const GROUP = "1203@g.us";

async function setUp(turns: { text: string }[] = []) {
  const telegram = new FakeGateway("telegram:main", "telegram");
  const whatsapp = new FakeGateway("whatsapp:main", "whatsapp");
  let names!: RoomNameStore;
  bench = await pipelineBench({
    turns: turns.length ? turns : Array.from({ length: 6 }, () => ({ text: "ok" })),
    config: { agents: { groups_require_mention: false } },
    gateways: [telegram, whatsapp],
    configure: (config) => {
      config.people.push({ key: "mira", name: "Mira", ids: ["whatsapp:62811@s.whatsapp.net", "whatsapp:777@lid", "discord:5"] });
    },
    deps: ({ db }) => {
      names = new RoomNameStore(db);
      return { roomMessages: new RoomMessageStore(db), roomNames: names };
    },
  });
  bench.pipeline.attach();
  return { telegram, whatsapp, bench, names };
}

const inGroup = (text: string, over: Partial<MessageEnvelope> = {}) =>
  envelope({ id: `wa-${Math.random()}`, timestamp: Date.now(), gateway: "whatsapp", gatewayId: "whatsapp:main", chatId: GROUP, chatType: "group", senderId: "62811@s.whatsapp.net", senderName: "mira 🌸", text, mentions: ["nouva"], ...over });

const fromTelegram = { agentId: "nouva", gatewayId: "telegram:main", chatId: "814", gateway: "telegram", senderId: "814", chatType: "dm" } as ToolContext;

describe("a room's name comes from its platform", () => {
  test("a group message asks the platform, and the name is kept — a one-to-one asks nothing", async () => {
    const { telegram, whatsapp, bench, names } = await setUp();
    const asked: string[] = [];
    whatsapp.roomTitle = async (chatId) => (asked.push(chatId), "Keluarga Besar");
    telegram.roomTitle = async (chatId) => (asked.push(chatId), "never");

    whatsapp.receive(inGroup("halo"));
    telegram.receive(envelope({ timestamp: Date.now(), senderId: "814", chatId: "814", text: "hai" }));
    await bench.pipeline.idle();

    expect(asked).toEqual([GROUP]);
    expect(names.get("whatsapp", GROUP)?.platformTitle).toBe("Keluarga Besar");
  });

  test("the agent is told the room's name beside the chat type", async () => {
    const { whatsapp, bench, names } = await setUp();
    names.setPlatformTitle("whatsapp", GROUP, "Keluarga Besar");
    whatsapp.receive(inGroup("halo"));
    await bench.pipeline.idle();
    expect(JSON.stringify(bench.requests.at(-1))).toContain("chat type: group · room: Keluarga Besar");
  });
});

describe("send_message finds a group by its name", () => {
  async function talked() {
    const set = await setUp();
    set.whatsapp.receive(inGroup("halo"));
    await set.bench.pipeline.idle();
    return set;
  }

  test("the platform's name", async () => {
    const { bench, names } = await talked();
    names.setPlatformTitle("whatsapp", GROUP, "Keluarga Besar");
    const found = resolveSendTarget("keluarga besar", bench.pipeline.messageSender().targets(fromTelegram), fromTelegram);
    expect(found.ok && `${found.chat.gatewayId}:${found.chat.chatId}`).toBe(`whatsapp:main:${GROUP}`);
  });

  test("the operator's rename, which the platform's name then no longer is", async () => {
    const { bench, names } = await talked();
    names.setPlatformTitle("whatsapp", GROUP, "Keluarga Besar");
    names.choose("whatsapp", GROUP, "Arisan");
    const targets = bench.pipeline.messageSender().targets(fromTelegram);
    expect(resolveSendTarget("arisan", targets, fromTelegram).ok).toBe(true);
    expect(resolveSendTarget("keluarga besar", targets, fromTelegram).ok).toBe(false);
  });

  test("never a memory file's name: a group with no name has none", async () => {
    const { bench } = await talked();
    const targets = bench.pipeline.messageSender().targets(fromTelegram);
    expect(targets.chats.find((chat) => chat.chatId === GROUP)?.title).toBeUndefined();
  });
});

describe("the Groups page's rooms", () => {
  test("listed flat, with the agents there and who spoke by their People name; renamed and cleared", async () => {
    const { whatsapp, bench, names } = await setUp();
    names.setPlatformTitle("whatsapp", GROUP, "Keluarga Besar");
    whatsapp.receive(inGroup("halo"));
    // Her second account: still one Mira in "who talks there" (live, it read "Kak Mira, Sam, Kak Mira").
    whatsapp.receive(inGroup("oke", { senderId: "777@lid", senderName: "~" }));
    await bench.pipeline.idle();

    const [room] = bench.pipeline.knownRooms();
    expect(room).toMatchObject({ gatewayId: "whatsapp:main", platform: "whatsapp", chatId: GROUP, name: "Keluarga Besar", platformTitle: "Keluarga Besar", dashboard: false, agents: ["nouva"], people: [{ key: "mira", name: "Mira" }] });
    expect(bench.pipeline.knownRooms()).toHaveLength(1);

    expect(bench.pipeline.renameRoom("whatsapp:main", GROUP, "Arisan")).toEqual({ ok: true, name: "Arisan" });
    expect(bench.pipeline.knownRooms()[0]?.name).toBe("Arisan");
    expect(bench.pipeline.renameRoom("whatsapp:main", GROUP, "")).toEqual({ ok: true, name: "Keluarga Besar" });
    expect(bench.pipeline.renameRoom("nowhere:x", GROUP, "x")).toMatchObject({ ok: false, why: "connection" });
  });
});

describe("a room that has no name yet", () => {
  test("listing it asks its platform in the background, so the page has the name the next time", async () => {
    // Live: every room from before 0.7.24 listed as an id, because a name was only asked as a message arrived.
    const { whatsapp, bench } = await setUp();
    whatsapp.receive(inGroup("halo"));
    await bench.pipeline.idle();
    whatsapp.roomTitle = async () => "Keluarga Besar";

    expect(bench.pipeline.knownRooms()[0]?.name).toBeUndefined();
    await eventually(() => bench.pipeline.knownRooms()[0]?.name === "Keluarga Besar", 4_000, "the room's name, asked in the background");
  });
});

describe("a thread's opening message", () => {
  test("in front of the first question there, named by People — and not again", async () => {
    const discord = new FakeGateway("discord:main", "discord");
    bench = await pipelineBench({
      turns: [{ text: "first" }, { text: "second" }],
      config: { agents: { groups_require_mention: false } },
      gateways: [discord],
      configure: (config) => {
        config.people.push({ key: "mira", name: "Mira", ids: ["discord:5"] });
      },
    });
    bench.pipeline.attach();
    const opener = { senderId: "5", senderName: "mira_w", text: "Lampu teras mati lagi", where: "#rumah" };
    const inThread = (text: string) =>
      envelope({ id: `d-${Math.random()}`, timestamp: Date.now(), gateway: "discord", gatewayId: "discord:main", chatId: "777", chatType: "channel", senderId: "6", senderName: "Sam", text, mentions: ["nouva"], threadOpener: opener });

    discord.receive(inThread("ada yang tahu kenapa?"));
    await bench.pipeline.idle();
    discord.receive(inThread("masih mati"));
    await bench.pipeline.idle();

    const first = JSON.stringify(bench.requests[0]);
    expect(first).toContain("[This thread was started from a message in #rumah by Mira: Lampu teras mati lagi]");
    const second = (bench.requests[1]?.messages ?? []) as { role: string; content: unknown }[];
    const lines = second.map((message) => JSON.stringify(message.content)).filter((line) => line.includes("This thread was started"));
    // Once, in the first question as it is stored — the second does not carry it again.
    expect(lines).toHaveLength(1);
  });
});
