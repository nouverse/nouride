/**
 * `GET /chat-list` — the chat page's list in one read: each agent's newest conversation in the dashboard, each room
 * with who answers an untagged message there, and each group on a chat app as one row however many of our bots sit in
 * it. Over the real session, turn, room and room-log stores; the pipeline's two answers (the groups it knows, the
 * router's untagged answer) are stood in for, and have tests of their own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import type { ChatListPayload } from "@nouride/wire";
import { openAndMigrate } from "@/db/index.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { registerChatListRoutes } from "@/modules/web/control/routes/chat-list.ts";
import { tempDir, turnStore } from "../helpers.ts";

const LOCAL = "web:dashboard";
const cleanup: (() => void)[] = [];

/** The clock the stores read, moved on by hand: which line is newest is the point, and a sleep would only hope for it. */
const realNow = Date.now;
let now = 1_760_000_000_000;
const tick = () => {
  now += 1_000;
};
beforeEach(() => {
  Date.now = () => now;
});
afterEach(() => {
  Date.now = realNow;
  for (const fn of cleanup.splice(0).reverse()) fn();
});

async function mount(options: { untagged?: (chatId: string) => string | null; groups?: unknown[]; helpers?: { agentId: string; chatId: string }[]; tags?: Record<string, Record<string, string>> } = {}) {
  const dataDir = tempDir("chat-list");
  cleanup.push(() => removePath(dataDir));
  const db = await openAndMigrate(join(dataDir, "test.db"));
  cleanup.push(() => db.close());
  const sessions = new SessionStore(db);
  const turns = turnStore(db);
  const rooms = new RoomStore(db);
  const roomMessages = new RoomMessageStore(db);
  const asked: unknown[] = [];
  const deps = {
    local: { id: LOCAL, platform: "web" },
    sessions,
    turns,
    rooms,
    roomMessages,
    registry: { all: () => ["nouva", "nestor", "kuro"].map((id) => ({ config: { id } })) },
    jobs: {
      running: (agentId: string) =>
        (options.helpers ?? []).filter((job) => job.agentId === agentId).map((job, n) => ({ id: `job_${n}`, kind: "helper", gatewayId: LOCAL, chatId: job.chatId })),
    },
    pipeline: {
      knownRooms: () => options.groups ?? [],
      agentTags: (platform: string) => options.tags?.[platform] ?? {},
      untaggedAnswerer: (where: { gateway: string; gatewayId: string; chatId: string }) => {
        asked.push(where);
        return options.untagged?.(where.chatId) ?? null;
      },
    },
    ctx: {
      gateways: new Map([["telegram:nouva", { platform: "telegram" }], ["telegram:nestor", { platform: "telegram" }]]),
      config: { people: [{ key: "gading", name: "Gading", ids: ["telegram:814"] }] },
    },
  };
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    // The control token reads every chat, as an admin does: what is the reader's own is `chat-list-whose.test.ts`.
    c.set("principal", { kind: "token", actor: "cli", role: "admin" });
    await next();
  });
  registerChatListRoutes(app as never, deps as never);
  const list = async () => {
    const response = await app.request("/chat-list");
    return { status: response.status, body: (await response.json()) as ChatListPayload };
  };
  /** A conversation with one finished exchange, its row written as a finished turn writes it. */
  const talk = (agentId: string, gatewayId: string, chatId: string, prompt: string, reply: string) => {
    const where = { agentId, gatewayId, chatId };
    const id = turns.begin({ sessionId: sessionIdFor(where), ...where, prompt });
    turns.finish(id, { status: "done", reply });
    sessions.save(where, [{ role: "user", content: prompt }, { role: "assistant", content: reply }], 10);
    return sessionIdFor(where);
  };
  return { list, talk, sessions, turns, rooms, roomMessages, asked };
}

describe("GET /chat-list", () => {
  test("an agent's row is its newest conversation in the dashboard: not a room's, not one on a chat app, and its last answer in plain words", async () => {
    const h = await mount();
    const older = h.talk("nouva", LOCAL, "web-1", "first", "an older answer");
    tick();
    const newest = h.talk("nouva", LOCAL, "web-2", "status?", "**All good**: `3` agents up.\n\nNothing waits for you.");
    tick();
    h.rooms.create({ gatewayId: LOCAL, chatId: "room-1", agentIds: ["nouva", "nestor"] });
    h.talk("nouva", LOCAL, "room-1", "@nouva in the room", "a room's answer");
    tick();
    h.talk("nouva", "telegram:nouva", "555", "on telegram", "a telegram answer");

    const { status, body } = await h.list();
    expect(status).toBe(200);
    const nouva = body.agents.find((agent) => agent.agentId === "nouva")!;
    expect(nouva.sessionId).toBe(newest);
    expect(nouva.sessionId).not.toBe(older);
    expect(nouva.last).toEqual({ from: "agent", name: "nouva", text: "All good: 3 agents up. Nothing waits for you." });
    expect(nouva.working).toBe(false);
  });

  test("an agent nobody has talked to in the dashboard has a row with no conversation; every agent is listed", async () => {
    const h = await mount();
    h.talk("kuro", "telegram:nouva", "555", "hi", "hello from telegram");
    const { body } = await h.list();
    expect(body.agents.map((agent) => agent.agentId).sort()).toEqual(["kuro", "nestor", "nouva"]);
    const kuro = body.agents.find((agent) => agent.agentId === "kuro")!;
    expect(kuro.sessionId).toBeUndefined();
    expect(kuro.last).toBeUndefined();
  });

  test("a conversation whose first turn still runs is the agent's newest, working, with its question as the last line and its helpers counted", async () => {
    const h = await mount({ helpers: [{ agentId: "nestor", chatId: "web-9" }, { agentId: "nestor", chatId: "web-9" }, { agentId: "nestor", chatId: "elsewhere" }] });
    h.talk("nestor", LOCAL, "web-8", "old", "old answer");
    tick();
    const where = { agentId: "nestor", gatewayId: LOCAL, chatId: "web-9" };
    h.turns.begin({ sessionId: sessionIdFor(where), ...where, prompt: "compare the caching of three repos" });
    expect(h.sessions.find(sessionIdFor(where))).toBeNull();

    const nestor = (await h.list()).body.agents.find((agent) => agent.agentId === "nestor")!;
    expect(nestor.sessionId).toBe(sessionIdFor(where));
    expect(nestor.working).toBe(true);
    expect(nestor.helpers).toBe(2);
    expect(nestor.last).toEqual({ from: "person", text: "compare the caching of three repos" });
  });

  test("a room: its members, its newest line whoever said it, and who answers a message that tags nobody, as the router says", async () => {
    const h = await mount({ untagged: (chatId) => (chatId === "room-1" ? "nouva" : null) });
    h.rooms.create({ gatewayId: LOCAL, chatId: "room-1", agentIds: ["nouva", "nestor"], title: "Harness research" });
    h.rooms.create({ gatewayId: LOCAL, chatId: "room-2", agentIds: ["nestor", "kuro"] });
    h.talk("nestor", LOCAL, "room-1", "@nestor summarise", "Nouride 9, Nakama 8.");
    tick();
    h.roomMessages.record({ id: "m1", gatewayId: LOCAL, chatId: "room-1", senderId: "u1", senderName: "Gading", text: "ok, note it down", at: Date.now() });

    const { body } = await h.list();
    const one = body.rooms.find((room) => room.chatId === "room-1")!;
    expect(one.title).toBe("Harness research");
    expect(one.members).toEqual(expect.arrayContaining(["nouva", "nestor"]));
    expect(one.last).toEqual({ from: "person", name: "Gading", text: "ok, note it down" });
    expect(one.untagged).toBe("nouva");
    const two = body.rooms.find((room) => room.chatId === "room-2")!;
    expect(two.untagged).toBeUndefined();
    expect(h.asked).toContainEqual({ gateway: "web", gatewayId: LOCAL, chatId: "room-1" });
  });

  test("a group two of our bots sit in is one row with both conversations, its last line the newest of what people and agents said; a dashboard room is not a group", async () => {
    const groups = [
      { gatewayId: "telegram:nestor", platform: "telegram", chatId: "-100", name: "Nouverse Office", dashboard: false, agents: ["nouva", "nestor"], people: [{ key: "gading", name: "Gading" }, { name: "Sam" }], lastActive: 1 },
      { gatewayId: LOCAL, platform: "web", chatId: "room-1", name: "A room", dashboard: true, agents: ["nouva"], people: [], lastActive: 2 },
      { gatewayId: "telegram:nouva", platform: "telegram", chatId: "-200", name: "Quiet", dashboard: false, agents: ["nouva"], people: [], lastActive: 1 },
    ];
    const h = await mount({ groups });
    const nouvaThere = h.talk("nouva", "telegram:nouva", "-100", "@nouva deploy?", "Deploy done, all green.");
    tick();
    const nestorThere = h.talk("nestor", "telegram:nestor", "-100", "@nestor and you?", "Reading.");
    tick();
    // Each bot keeps the lines it was handed, and one can be handed less than the other: here, a line each.
    h.roomMessages.record({ id: "g0", gatewayId: "telegram:nestor", chatId: "-100", senderId: "902", senderName: "Rani", text: "hi all", at: Date.now() - 1_000 });
    h.roomMessages.record({ id: "g1", gatewayId: "telegram:nouva", chatId: "-100", senderId: "814", senderName: "gading_n", text: "thanks both", at: Date.now() });

    const { body } = await h.list();
    expect(body.groups.map((group) => group.chatId)).toEqual(["-100", "-200"]);
    const office = body.groups[0]!;
    expect(office.name).toBe("Nouverse Office");
    expect(office.sessions.map((session) => session.sessionId).sort()).toEqual([nouvaThere, nestorThere].sort());
    // Under People's name, as the conversation shows them, not the name their app gave.
    expect(office.last).toEqual({ from: "person", name: "Gading", text: "thanks both" });
    // The two the Groups page knew from one bot's copy, and one more from the other's.
    expect(office.people).toBe(3);
    expect(office.working).toBe(false);
  });

  test("a group carries each agent's tag as its platform writes it, the tag to the agent; a platform where none has one, none", async () => {
    const groups = [
      { gatewayId: "discord:nouva", platform: "discord", chatId: "881", name: "#general", dashboard: false, agents: ["nouva", "nexa"], people: [], lastActive: 2 },
      { gatewayId: "telegram:nouva", platform: "telegram", chatId: "-100", name: "Office", dashboard: false, agents: ["nouva"], people: [], lastActive: 1 },
    ];
    const h = await mount({ groups, tags: { discord: { nouva: "<@100000000000000001>", nexa: "<@100000000000000002>" } } });
    const { body } = await h.list();
    expect(body.groups.find((group) => group.chatId === "881")?.tags).toEqual({ "<@100000000000000001>": "nouva", "<@100000000000000002>": "nexa" });
    expect(body.groups.find((group) => group.chatId === "-100")).not.toHaveProperty("tags");
  });

  // A supergroup numbers a line once for every bot in it; a basic group numbers it for each bot apart (`idsPerConnection`).
  for (const group of [
    { kind: "one id in both bots", idOn: (n: number) => `g${n}`, idsPerConnection: false },
    { kind: "each bot its own id", idOn: (n: number, gatewayId: string) => `${gatewayId}#${n}`, idsPerConnection: true },
  ]) {
    test(`a line both our bots heard is one line of the group (${group.kind}): who spoke lately is read from its newest lines, not its rows`, async () => {
      const groups = [{ gatewayId: "telegram:nestor", platform: "telegram", chatId: "-100", name: "Nouverse Office", dashboard: false, agents: ["nouva", "nestor"], people: [], lastActive: 1 }];
      const h = await mount({ groups });
      h.talk("nouva", "telegram:nouva", "-100", "@nouva deploy?", "Done.");
      h.talk("nestor", "telegram:nestor", "-100", "@nestor and you?", "Reading.");
      tick();
      // Sam once, then thirty lines from Rani, each handed to both bots: two rows a line.
      const lines = [{ senderId: "903", senderName: "Sam", text: "morning" }, ...Array.from({ length: 30 }, (_, n) => ({ senderId: "902", senderName: "Rani", text: `note ${n + 1}` }))];
      lines.forEach((line, n) => {
        for (const gatewayId of ["telegram:nouva", "telegram:nestor"]) {
          h.roomMessages.record({ ...line, id: group.idOn(n, gatewayId), gatewayId, chatId: "-100", at: Date.now() + n * 1_000, idsPerConnection: group.idsPerConnection });
        }
      });

      const office = (await h.list()).body.groups[0]!;
      expect(office.last).toEqual({ from: "person", name: "Rani", text: "note 30" });
      // Thirty-one lines are within the fifty read; counted as rows, Sam's would have fallen out.
      expect(office.people).toBe(2);
    });
  }
});
