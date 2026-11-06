/**
 * A message sent into another chat is part of that chat's conversation (0.7.23).
 *
 * The live case, end to end through a real pipeline: asked in a Telegram one-to-one to post into a WhatsApp group, the
 * agent calls `send_message`; the WhatsApp connection posts it; and when somebody in the group then asks about it, the
 * turn there has it in its history — the agent's own words, after a line saying where they came from. Before, it went
 * out through a scheduled job and the group's conversation never knew it had been said.
 *
 * The same for a scheduled job's output delivered into a chat: in the agent's conversation there once it landed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { messageText, type GatewayInstanceConfig, type ToolContext } from "@nouride/shared";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { recordSaid } from "@/modules/pipeline/send-message.ts";
import type { TurnContext } from "@/modules/pipeline/turn-context.ts";
import { createSendMessageTool } from "@/modules/tools/builtins/send-message.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

const GROUP = { agentId: "nouva", gatewayId: "whatsapp:main", chatId: "1203@g.us" };

async function setUp(turns: Parameters<typeof pipelineBench>[0] extends infer O ? (O extends { turns?: infer T } ? T : never) : never) {
  const telegram = new FakeGateway("telegram:main", "telegram");
  const whatsapp = new FakeGateway("whatsapp:main", "whatsapp");
  bench = await pipelineBench({
    turns,
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["send_message"]\n',
    config: { agents: { groups_require_mention: false } },
    gateways: [telegram, whatsapp],
    deps: ({ db }) => ({ roomMessages: new RoomMessageStore(db) }),
  });
  bench.pipeline.setTools(new Map([["send_message", createSendMessageTool(bench.pipeline.messageSender())]]));
  bench.pipeline.attach();
  return { telegram, whatsapp, bench };
}

const inGroup = (text: string) =>
  envelope({ id: `wa-${Math.random()}`, timestamp: Date.now(), gateway: "whatsapp", gatewayId: "whatsapp:main", chatId: "1203@g.us", chatType: "group", senderId: "62811@s.whatsapp.net", senderName: "Mira", text, mentions: ["nouva"] });

describe("send_message, end to end", () => {
  test("posts through the target's connection, and the next turn in that chat has it in its history", async () => {
    const { telegram, whatsapp, bench } = await setUp([
      { text: "Halo semua!" },
      { toolCalls: [{ id: "s1", name: "send_message", args: { to: "whatsapp:main:1203@g.us", text: "Rapat keluarga jam 7 malam." } }] },
      { text: "Sudah kukirim ke grup." },
      { text: "Jam 7 malam, Mira." },
    ]);
    // Nouva has talked in the group before: it is a chat she knows.
    whatsapp.receive(inGroup("halo nouva"));
    await bench.pipeline.idle();
    expect(whatsapp.sent.map((sent) => sent.text)).toEqual(["Halo semua!"]);

    telegram.receive(envelope({ timestamp: Date.now(), senderId: "814", senderName: "Gading", chatId: "814", text: "kirim ke grup wa: rapat jam 7" }));
    await bench.pipeline.idle();

    expect(whatsapp.sent.slice(1).map((sent) => ({ chatId: sent.chatId, text: sent.text }))).toEqual([{ chatId: "1203@g.us", text: "Rapat keluarga jam 7 malam." }]);
    expect(telegram.sent.at(-1)?.text).toBe("Sudah kukirim ke grup.");
    // Asked about by where it goes, in words: the group, as the room's log knows it.
    expect(JSON.stringify(bench.requests.at(-1))).toContain('Delivered to the whatsapp group (Mira): the platform took it');

    whatsapp.receive(inGroup("jam berapa tadi?"));
    await bench.pipeline.idle();

    const asked = (bench.requests.at(-1)?.messages ?? []) as { role: string; content: unknown }[];
    const said = asked.map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`);
    const sentAt = said.indexOf("assistant: Rapat keluarga jam 7 malam.");
    expect(sentAt).toBeGreaterThan(0);
    expect(said[sentAt - 1]).toStartWith("user: [system] You sent the message below into this chat with send_message, from your telegram one-to-one");
    // Before the question it is about, and after what was said there before.
    expect(said.findIndex((line) => line.includes("Halo semua!"))).toBeLessThan(sentAt);
    expect(said.findIndex((line) => line.includes("jam berapa tadi?"))).toBeGreaterThan(sentAt);
    expect(whatsapp.sent.at(-1)?.text).toBe("Jam 7 malam, Mira.");
  });

  test("every chat an agent can send into, and what it is — a group by its people, a one-to-one by who is there (0.8.0)", async () => {
    const { telegram, whatsapp, bench } = await setUp([{ text: "Halo semua!" }, { text: "Halo Gading." }]);
    whatsapp.receive(inGroup("halo nouva"));
    await bench.pipeline.idle();
    telegram.receive(envelope({ timestamp: Date.now(), senderId: "814", senderName: "Gading", chatId: "814", text: "halo" }));
    await bench.pipeline.idle();

    const chats = bench.pipeline.reachableChats().map((chat) => ({ address: `${chat.gatewayId}:${chat.chatId}`, kind: chat.kind, people: chat.people.map((one) => one.name) }));
    // Most recently active first: the one-to-one spoke last.
    expect(chats).toEqual([
      { address: "telegram:main:814", kind: "dm", people: ["814"] },
      { address: "whatsapp:main:1203@g.us", kind: "group", people: ["Mira"] },
    ]);
  });

  test("a scheduled job's output delivered into a chat is in the agent's conversation there", async () => {
    const { whatsapp, bench } = await setUp([{ text: "unused" }]);
    bench.sessions.save(GROUP, [{ role: "user", content: "halo", timestamp: 1 }, { role: "assistant", content: "Halo semua!" }], 10);
    const sent = await bench.pipeline.cronExecutors().deliver({ gatewayId: GROUP.gatewayId, chatId: GROUP.chatId }, "Laporan harian: semua aman.", { agentId: "nouva", job: "laporan" });

    expect(sent).toEqual({ ok: true });
    expect(whatsapp.sent.at(-1)?.text).toBe("Laporan harian: semua aman.");
    const history = bench.sessions.load(GROUP).messages.map((message) => `${message.role}: ${messageText(message.content)}`);
    expect(history.slice(-2)).toEqual([
      'user: [system] Your scheduled job "laporan" posted the message below in this chat. It is part of this conversation now: anyone here may answer it.',
      "assistant: Laporan harian: semua aman.",
    ]);
  });

  test("a failure notice is the daemon's, and stays out of the conversation", async () => {
    const { bench } = await setUp([{ text: "unused" }]);
    bench.sessions.save(GROUP, [{ role: "user", content: "halo", timestamp: 1 }, { role: "assistant", content: "Halo semua!" }], 10);
    await bench.pipeline.cronExecutors().deliver({ gatewayId: GROUP.gatewayId, chatId: GROUP.chatId }, "Scheduled job **laporan** failed.");
    expect(bench.sessions.load(GROUP).messages).toHaveLength(2);
  });

  test("an agent at work in that chat: written after its turn saved, not under it", async () => {
    const { bench } = await setUp([{ text: "unused" }]);
    let free!: () => void;
    const freed = new Promise<void>((resolve) => (free = resolve));
    let busy = true;
    // The two things `recordSaid` asks of the turns: is this agent at work there, and when it is not.
    const turns = {
      deps: { sessions: bench.sessions, config: bench.config },
      atomically: <T>(work: () => T) => work(),
      isBusy: () => busy,
      waitUntilFree: () => freed,
    } as unknown as TurnContext;

    recordSaid(turns, { ...GROUP, text: "Laporan harian.", note: "a note" });
    // The running turn ends, saving the history it loaded before the message was sent…
    bench.sessions.save(GROUP, [{ role: "user", content: "halo", timestamp: 1 }, { role: "assistant", content: "Halo semua!" }], 10);
    busy = false;
    free();
    await freed;
    await Promise.resolve();

    // …and the message is after it, not lost under it.
    expect(bench.sessions.load(GROUP).messages.map((message) => messageText(message.content))).toEqual(["halo", "Halo semua!", "[system] a note", "Laporan harian."]);
  });

  test("what it can reach: its conversations and its own connection's people — never another agent's bot, never a cron run", async () => {
    const connection = (id: string, platform: "telegram" | "whatsapp", agent: string) =>
      ({ id, platform, name: id.split(":")[1], enabled: true, tokenSecret: "unused", agent }) as unknown as GatewayInstanceConfig;
    bench = await pipelineBench({
      agents: ["nouva", "nox"],
      gateways: [new FakeGateway("telegram:main", "telegram"), new FakeGateway("telegram:nox", "telegram"), new FakeGateway("whatsapp:nouva", "whatsapp")],
      configure: (config) => {
        config.gateways.push(connection("telegram:nox", "telegram", "nox"), connection("whatsapp:nouva", "whatsapp", "nouva"));
        config.people.push({ key: "mira", name: "Mira", ids: ["whatsapp:62811@s.whatsapp.net", "telegram:555"] });
      },
    });
    const talked = (agentId: string, gatewayId: string, chatId: string) =>
      bench!.sessions.save({ agentId, gatewayId, chatId }, [{ role: "user", content: "halo", timestamp: 1 }, { role: "assistant", content: "hai" }], 10);
    talked("nouva", "telegram:main", "814");
    talked("nouva", "telegram:nox", "999"); // through Nox's own bot: not Nouva's to use
    talked("nouva", "telegram:main", "cron:job-1"); // a scheduled run's conversation, an address on no platform
    talked("nox", "telegram:main", "777"); // somebody else's conversation

    const ctx = { agentId: "nouva", gatewayId: "telegram:main", chatId: "814", gateway: "telegram", senderId: "814", chatType: "dm" } as ToolContext;
    const targets = bench.pipeline.messageSender().targets(ctx);

    expect(targets.chats.map((chat) => `${chat.gatewayId}:${chat.chatId}`)).toEqual(["telegram:main:814", "whatsapp:nouva:62811@s.whatsapp.net"]);
    expect(targets.chats[1]?.people).toEqual([{ key: "mira", name: "Mira" }]);
    expect(targets.othersGateways).toEqual(["telegram:nox"]);
  });
});

describe("a line from the daemon into the chat a call came from (0.8.8)", () => {
  test("lands in that chat through the agent's connection; one it has no connection for is said to have not", async () => {
    // What `agent_configure` tells the person when an agent moves its coding CLI to another model.
    const { telegram, whatsapp, bench } = await setUp([]);
    const ctx = { agentId: "nouva", gateway: "telegram", gatewayId: "telegram:main", chatId: "814", chatType: "dm", callId: "c1" } as ToolContext;
    const tell = bench.pipeline.chatNotice();
    expect(await tell(ctx, 'Nouva changed its Claude Code model from sonnet to opus, on the account "work".')).toBe(true);
    expect(telegram.sent.map((sent) => ({ chatId: sent.chatId, text: sent.text }))).toEqual([{ chatId: "814", text: 'Nouva changed its Claude Code model from sonnet to opus, on the account "work".' }]);
    expect(whatsapp.sent).toEqual([]);
    expect(await tell({ ...ctx, gatewayId: "discord:gone" }, "nowhere")).toBe(false);
  });
});
