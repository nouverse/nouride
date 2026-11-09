/**
 * The room log's key (`080_chat_messages_key.sql`): a line is the connection that heard it, its chat, and the platform's
 * id for it, together.
 *
 * The id alone was the key. Telegram numbers a group's messages per chat, so message 412 in one group and 412 in another
 * were one row and the second group's line was dropped. And two of our bots in one group are two connections, each handed
 * its own copy of a line: the first one's was kept, the second's dropped, so whatever reads the second bot's log of the
 * group (its agent's memory of it, its conversation read in the dashboard) missed what it heard. Driven through the
 * pipeline as a platform drives it, and the transcript read through its route.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { openDatabase } from "@nouride/runtime";
import { sessionIdFor, type MessageEnvelope } from "@nouride/shared";
import type { Transcript } from "@nouride/wire";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { registerChatRoutes } from "@/modules/web/control/routes/chat.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

/** Our bots on Telegram, one per agent, and whether a group message has to tag one for it to answer. */
async function daemon(options: { bots: string[]; answers?: string[]; mention: boolean }) {
  const bots = options.bots.map((agent) => new FakeGateway(`telegram:${agent}`, "telegram"));
  let roomMessages!: RoomMessageStore;
  bench = await pipelineBench({
    turns: (options.answers ?? []).map((text) => ({ text })),
    agents: options.bots,
    config: {
      agents: { groups_require_mention: options.mention },
      gateways: { telegram: Object.fromEntries(options.bots.map((agent) => [agent, { enabled: true, token: `t-${agent}`, agent }])) },
    },
    gateways: bots,
    deps: ({ db }) => ({ roomMessages: (roomMessages = new RoomMessageStore(db)) }),
  });
  const { pipeline } = bench;
  pipeline.setTools(new Map());
  pipeline.attach();
  /** A person's line in a group, as `bot` is handed it. */
  const said = async (bot: FakeGateway, over: Partial<MessageEnvelope>) => {
    bot.receive(envelope({ gatewayId: bot.id, chatType: "group", senderId: "814", senderName: "Gading", timestamp: Date.now(), ...over }));
    await pipeline.idle();
  };
  const lines = (gatewayId: string, chatId: string) => roomMessages.forChat(gatewayId, chatId).map((message) => [message.id, message.text]);
  return { bots, said, lines, roomMessages, bench };
}

/** The dashboard's transcript of one conversation, read through its route as the read-only group view reads it. */
async function transcriptOf(h: Awaited<ReturnType<typeof daemon>>, where: { agentId: string; gatewayId: string; chatId: string }): Promise<Transcript> {
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "viewer", role: "viewer", user: { username: "viewer" } });
    await next();
  });
  const deps = {
    local: { id: "web:dashboard" },
    sessions: h.bench.sessions,
    turns: h.bench.turns,
    roomMessages: h.roomMessages,
    audit: { record: () => undefined },
    ctx: { config: { daemon: {}, people: [] } },
  };
  registerChatRoutes(app as never, deps as never);
  return (await (await app.request(`/sessions/${encodeURIComponent(sessionIdFor(where))}/turns`)).json()) as Transcript;
}

describe("two Telegram groups, one bot, the same message number in each", () => {
  test("both lines are kept, each read back under its own chat", async () => {
    const h = await daemon({ bots: ["nouva"], answers: ["Yes, at nine.", "Rani has them."], mention: false });
    await h.said(h.bots[0]!, { id: "412", chatId: "-100", text: "is the deploy done?" });
    await h.said(h.bots[0]!, { id: "412", chatId: "-200", senderId: "902", senderName: "Rani", text: "who has the keys?" });

    expect(h.lines("telegram:nouva", "-100")).toEqual([["412", "is the deploy done?"]]);
    expect(h.lines("telegram:nouva", "-200")).toEqual([["412", "who has the keys?"]]);
  });

  test("a turn's reply attaches to its own group's message, not the other group's of the same number", async () => {
    const h = await daemon({ bots: ["nouva"], answers: ["Yes, at nine.", "Rani has them."], mention: false });
    await h.said(h.bots[0]!, { id: "412", chatId: "-100", text: "is the deploy done?" });
    await h.said(h.bots[0]!, { id: "412", chatId: "-200", senderId: "902", senderName: "Rani", text: "who has the keys?" });

    for (const [chatId, asked, answer] of [
      ["-100", "is the deploy done?", "Yes, at nine."],
      ["-200", "who has the keys?", "Rani has them."],
    ] as const) {
      const where = { agentId: "nouva", gatewayId: "telegram:nouva", chatId };
      const turn = h.bench.turns.forChat(where.gatewayId, chatId).at(-1)!;
      expect(turn.messageId).toBe("412");
      const transcript = await transcriptOf(h, where);
      expect(transcript.turns.map((one) => one.reply)).toEqual([answer]);
      // The line the turn answered, by its id, is in this group's log with this group's words: the reply is drawn under
      // it. Dropped, the reply sat under whatever was said before it, or under nothing.
      expect(transcript.messages?.find((message) => message.id === turn.messageId)?.text).toBe(asked);
    }
  });
});

describe("two of our bots in one group", () => {
  test("each connection keeps the line it was handed, so each one's log has it", async () => {
    const h = await daemon({ bots: ["nouva", "nestor"], mention: true });
    // A supergroup numbers per chat: both bots are handed message 77.
    for (const bot of h.bots) await h.said(bot, { id: "77", chatId: "-100", text: "who is on call tonight?" });

    expect(h.lines("telegram:nouva", "-100")).toEqual([["77", "who is on call tonight?"]]);
    expect(h.lines("telegram:nestor", "-100")).toEqual([["77", "who is on call tonight?"]]);
    // What the second bot's agent's memory of the group, and its conversation in the dashboard, read the group by.
    expect(h.roomMessages.isRoom("telegram:nestor", "-100")).toBe(true);
  });

  test("the group read across both bots has the line once, and no other group's line of the same number", async () => {
    const h = await daemon({ bots: ["nouva", "nestor"], mention: true });
    for (const bot of h.bots) await h.said(bot, { id: "77", chatId: "-100", text: "who is on call tonight?" });
    await h.said(h.bots[0]!, { id: "77", chatId: "-200", text: "lunch?" });

    const room = h.roomMessages.inRoom(["telegram:nouva", "telegram:nestor"], "-100");
    expect(room.map((message) => [message.id, message.text])).toEqual([["77", "who is on call tonight?"]]);
  });

  test("in a supergroup, two lines alike from one person in one second are two lines: only their ids tell them apart", async () => {
    const h = await daemon({ bots: ["nouva", "nestor"], mention: true });
    const second = 1_762_000_000_000;
    for (const bot of h.bots) {
      await h.said(bot, { id: "500", chatId: "-100", text: "ok", timestamp: second });
      await h.said(bot, { id: "501", chatId: "-100", text: "ok", timestamp: second });
    }
    expect(h.roomMessages.inRoom(["telegram:nouva", "telegram:nestor"], "-100").map((message) => message.id)).toEqual(["500", "501"]);
  });

  test("the same connection handed the same line again keeps it once", async () => {
    const h = await daemon({ bots: ["nouva"], mention: true });
    await h.said(h.bots[0]!, { id: "77", chatId: "-100", text: "who is on call tonight?" });
    await h.said(h.bots[0]!, { id: "77", chatId: "-100", text: "who is on call tonight?" });
    expect(h.lines("telegram:nouva", "-100")).toEqual([["77", "who is on call tonight?"]]);
  });
});

describe("two of our bots in a Telegram basic group, which numbers a line for each bot apart", () => {
  test("each bot keeps its copy under its own id, and the group read across both has each line once", async () => {
    const h = await daemon({ bots: ["nouva", "nestor"], mention: true });
    const second = 1_762_000_000_000;
    // One line is 57 to one bot and 102 to the other, sent at one moment the platform states for both.
    const copies = [
      { bot: 0, id: "57", text: "who is on call tonight?", timestamp: second },
      { bot: 1, id: "102", text: "who is on call tonight?", timestamp: second },
      // The same words again a second later: another line.
      { bot: 0, id: "58", text: "who is on call tonight?", timestamp: second + 1_000 },
      { bot: 1, id: "103", text: "who is on call tonight?", timestamp: second + 1_000 },
    ];
    for (const copy of copies) await h.said(h.bots[copy.bot]!, { id: copy.id, chatId: "-300", text: copy.text, timestamp: copy.timestamp, idsPerConnection: true });

    expect(h.lines("telegram:nouva", "-300").map(([id]) => id)).toEqual(["57", "58"]);
    expect(h.lines("telegram:nestor", "-300").map(([id]) => id)).toEqual(["102", "103"]);
    const room = h.roomMessages.inRoom(["telegram:nouva", "telegram:nestor"], "-300");
    expect(room.map((message) => [message.text, message.at])).toEqual([
      ["who is on call tonight?", second],
      ["who is on call tonight?", second + 1_000],
    ]);
  });
});

describe("a database of 0.8.28, its room log keyed by the id alone", () => {
  const COLUMNS = "id, gateway_id, chat_id, sender_id, sender_name, text, attachments, at";
  const rows = [
    ["412", "telegram:nouva", "-100", "814", "Gading", "is the deploy done?", null, 1_000],
    ["413", "telegram:nouva", "-100", "902", null, "yes", JSON.stringify([{ name: "a.png", mimeType: "image/png", kind: "image" }]), 2_000],
    ["1305", "discord:nestor", "c1", "u7", "Sam", "halo", null, 3_000],
  ] as const;

  test("keeps every line, is keyed by the connection, the chat and the id, and has its indexes", async () => {
    const db = openDatabase(":memory:");
    await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 79));
    const insert = db.prepare(`INSERT INTO chat_messages (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) insert.run(...row);
    // What the old key did to a second group's message 412.
    expect(() => insert.run("412", "telegram:nouva", "-200", "902", "Rani", "who has the keys?", null, 4_000)).toThrow();

    await migrate(db);
    expect(db.userVersion()).toBe(80);
    const all = () => db.prepare<Record<string, unknown>>(`SELECT ${COLUMNS} FROM chat_messages ORDER BY at`).all();
    expect(all()).toEqual(rows.map(([id, gateway_id, chat_id, sender_id, sender_name, text, attachments, at]) => ({ id, gateway_id, chat_id, sender_id, sender_name, text, attachments, at })));

    // The same number in another group, and the same line through another bot: each is a row of its own now.
    const store = new RoomMessageStore(db);
    store.record({ id: "412", gatewayId: "telegram:nouva", chatId: "-200", senderId: "902", senderName: "Rani", text: "who has the keys?", at: 4_000 });
    store.record({ id: "412", gatewayId: "telegram:nestor", chatId: "-100", senderId: "814", senderName: "Gading", text: "is the deploy done?", at: 1_000 });
    expect(all()).toHaveLength(5);
    // One connection handed one line twice is still one row, and the key refuses a second.
    store.record({ id: "412", gatewayId: "telegram:nouva", chatId: "-100", senderId: "814", senderName: "Gading", text: "is the deploy done?", at: 1_000 });
    expect(all()).toHaveLength(5);
    expect(() => insert.run("412", "telegram:nouva", "-100", "814", "Gading", "again", null, 5_000)).toThrow(/UNIQUE/);

    const key = db
      .prepare<{ name: string; pk: number }>("SELECT name, pk FROM pragma_table_info('chat_messages') WHERE pk > 0 ORDER BY pk")
      .all()
      .map((column) => column.name);
    expect(key).toEqual(["gateway_id", "chat_id", "id"]);
    const objects = db
      .prepare<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'chat_messages' AND sql IS NOT NULL ORDER BY type, name")
      .all()
      .map((object) => [object.type, object.name, object.type === "index" ? object.sql : ""]);
    expect(objects).toEqual([
      ["index", "idx_chat_messages_at", "CREATE INDEX idx_chat_messages_at ON chat_messages(at)"],
      ["index", "idx_chat_messages_chat", "CREATE INDEX idx_chat_messages_chat ON chat_messages(gateway_id, chat_id, at)"],
      ["table", "chat_messages", ""],
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'chat_messages_rebuild%'").all()).toEqual([]);
    db.close();
  });

  test("a basic group's copies, two rows under two ids already, are marked and read as one line", async () => {
    const db = openDatabase(":memory:");
    await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 79));
    const insert = db.prepare(`INSERT INTO chat_messages (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run("57", "telegram:nouva", "-300", "814", "Gading", "who is on call tonight?", null, 1_000);
    insert.run("102", "telegram:nestor", "-300", "814", "Gading", "who is on call tonight?", null, 1_000);
    // Heard by one bot only, and one bot's line of the same words a second later: neither has a copy to be one with.
    insert.run("58", "telegram:nouva", "-300", "814", "Gading", "who is on call tonight?", null, 2_000);
    insert.run("412", "telegram:nouva", "-100", "814", "Gading", "is the deploy done?", null, 1_000);

    await migrate(db);
    const marked = db.prepare<{ gateway_id: string; id: string; ids_per_connection: number }>("SELECT gateway_id, id, ids_per_connection FROM chat_messages ORDER BY chat_id, at, gateway_id").all();
    expect(marked.map((row) => [row.gateway_id, row.id, row.ids_per_connection])).toEqual([
      ["telegram:nouva", "412", 0],
      ["telegram:nestor", "102", 1],
      ["telegram:nouva", "57", 1],
      ["telegram:nouva", "58", 0],
    ]);
    const room = new RoomMessageStore(db).inRoom(["telegram:nouva", "telegram:nestor"], "-300");
    expect(room.map((message) => message.at)).toEqual([1_000, 2_000]);
    db.close();
  });
});
