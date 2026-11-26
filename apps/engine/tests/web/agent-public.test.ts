/**
 * An open agent's conversations with the public have a place of their own: its page, for an admin.
 *
 * Anyone may write to an agent open to everyone, so those conversations are no person's. Listed with everybody's
 * chats they would bury the household's own; among the chats an automation can report to they would be a list of
 * strangers; and a group anyone added its bot to is not the household's. So each of those lists leaves them out, and
 * `GET /agents/:id/public` lists them: who wrote, what they first asked, when, and whether they are blocked. Over the
 * real stores and the real routes.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import type { AgentPublic, ChatListPayload, SessionSummary } from "@nouride/wire";
import { openAndMigrate } from "@/db/index.ts";
import { AccessStore } from "@/modules/access/access.store.ts";
import { OpenDoorStore } from "@/modules/access/open-door.store.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { registerAgentPublicRoutes } from "@/modules/web/control/routes/agent-public.ts";
import { registerChatListRoutes } from "@/modules/web/control/routes/chat-list.ts";
import { registerConversationRoutes } from "@/modules/web/control/routes/conversations.ts";
import { registerKnownChatRoutes } from "@/modules/web/control/routes/known-chats.ts";
import { tempDir, turnStore } from "../helpers.ts";

const LOCAL = "web:dashboard";
const PEOPLE = [{ key: "gading", name: "Gading", ids: ["web:u1", "telegram:814"] }];
const ACCOUNTS = {
  admin: { kind: "user", actor: "gading", role: "admin", user: { id: "u1", username: "gading", displayName: "", role: "admin" } },
  operator: { kind: "user", actor: "rina", role: "operator", user: { id: "u2", username: "rina", displayName: "", role: "operator" } },
} as const;
const DAY = Date.parse("2026-09-25T00:00:00+07:00");
const LIMITS = { maxDailyTokens: 1_000, maxDailyMessagesPerPerson: 10 };

const cleanup: (() => void)[] = [];
afterEach(() => {
  setSystemTime();
  for (const undo of cleanup.splice(0).reverse()) undo();
});

/** Where each conversation is: the household's own, and Nora's with the public on the two connections she owns. */
const OWN_WEB = { agentId: "nouva", gatewayId: LOCAL, chatId: "web-g" };
const OWN_DM = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "814" };
const HOME_GROUP = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "-100" };
const BUDI = { agentId: "nora", gatewayId: "telegram:nora", chatId: "7001" };
const SITI = { agentId: "nora", gatewayId: "whatsapp:shop", chatId: "62812@s.whatsapp.net" };
const THEIR_GROUP = { agentId: "nora", gatewayId: "telegram:nora", chatId: "-200" };
/** The admin, trying their own open bot from the dashboard: their own chat, not the public's. */
const OWNER_TRIES = { agentId: "nora", gatewayId: LOCAL, chatId: "web-try" };
/** The admin on Nora's bot, naming the other agent: that agent's conversation, a known person's, on an open connection. */
const OWNER_NAMES_NOUVA = { agentId: "nouva", gatewayId: "telegram:nora", chatId: "814" };
/** The household's own group, which Nora's bot was added to beside Nouva's. */
const SHARED_GROUP = { agentId: "nouva", gatewayId: "telegram:nora", chatId: "-300" };

async function house(options: { noraOpen?: boolean } = {}) {
  const noraOpen = options.noraOpen ?? true;
  const dir = tempDir("agent-public");
  cleanup.push(() => removePath(dir));
  const db = await openAndMigrate(join(dir, "t.db"));
  cleanup.push(() => db.close());
  const sessions = new SessionStore(db);
  const turns = turnStore(db);
  const roomMessages = new RoomMessageStore(db);
  const access = new AccessStore({ db, codeTtlMs: 1, notifyCooldownMs: 1, denyCooldownMs: 1 });
  const openDoor = new OpenDoorStore(db);
  // Each a minute after the one before, so "newest first" is an order and not a tie.
  let clock = Date.parse("2026-09-25T09:00:00+07:00");
  const said = (where: typeof OWN_WEB, senderId: string, prompt: string) => {
    setSystemTime(new Date((clock += 60_000)));
    const turn = turns.begin({ sessionId: sessionIdFor(where), ...where, senderId, prompt })!;
    turns.finish(turn, { status: "done", reply: `about ${prompt}` });
    sessions.save(where, [{ role: "user", content: prompt, timestamp: clock }], 1);
  };
  said(OWN_WEB, "u1", "gaji bulan ini");
  said(OWN_DM, "814", "jadwal dokter");
  roomMessages.record({ id: "m1", gatewayId: HOME_GROUP.gatewayId, chatId: HOME_GROUP.chatId, senderId: "814", senderName: "Gading", text: "lampu teras mati", at: 1 });
  said(HOME_GROUP, "814", "lampu teras mati");
  said(BUDI, "7001", "when do you open?");
  said(SITI, "62812@s.whatsapp.net", "berapa harga kopi?");
  roomMessages.record({ id: "m2", gatewayId: THEIR_GROUP.gatewayId, chatId: THEIR_GROUP.chatId, senderId: "9009", senderName: "Somebody", text: "nora, are you a bot?", at: 2 });
  said(THEIR_GROUP, "9009", "are you a bot?");
  said(OWNER_TRIES, "u1", "testing my own bot");
  said(OWNER_NAMES_NOUVA, "814", "nouva: restart the server");
  roomMessages.record({ id: "m3", gatewayId: SHARED_GROUP.gatewayId, chatId: SHARED_GROUP.chatId, senderId: "814", senderName: "Gading", text: "nouva, lampu?", at: 3 });
  said(SHARED_GROUP, "814", "lampu?");
  // What the door kept of who wrote: a name for Budi, none for Siti.
  openDoor.take({ agentId: "nora", gatewayId: BUDI.gatewayId, senderId: "7001", name: "Budi Santoso", day: DAY, tokensToday: 0, limits: LIMITS });
  openDoor.take({ agentId: "nora", gatewayId: SITI.gatewayId, senderId: "62812@s.whatsapp.net", day: DAY, tokensToday: 0, limits: LIMITS });
  access.block(SITI.gatewayId, "62812@s.whatsapp.net", "gading");

  const agent = (id: string, open: boolean) => ({ config: { id, enabled: true, displayName: id, ...(open ? { access: "open" } : {}) } });
  let as: keyof typeof ACCOUNTS = "admin";
  const deps = {
    local: { id: LOCAL, platform: "web" },
    ctx: {
      config: {
        people: PEOPLE,
        daemon: {},
        gateways: [
          { id: "telegram:nouva", platform: "telegram", enabled: true, agent: "nouva" },
          { id: "telegram:nora", platform: "telegram", enabled: true, agent: "nora" },
          { id: "whatsapp:shop", platform: "whatsapp", enabled: true, agent: "nora" },
        ],
      },
      gateways: new Map([
        ["telegram:nouva", { platform: "telegram" }],
        ["telegram:nora", { platform: "telegram" }],
        ["whatsapp:shop", { platform: "whatsapp" }],
      ]),
    },
    sessions,
    turns,
    roomMessages,
    access,
    openDoor,
    registry: {
      get: (id: string) => (id === "nouva" ? agent("nouva", false) : id === "nora" ? agent("nora", noraOpen) : undefined),
      enabled: () => [agent("nouva", false), agent("nora", noraOpen)],
      all: () => [agent("nouva", false), agent("nora", noraOpen)],
      isPaused: () => false,
    },
    pipeline: {
      chatTypeOf: () => undefined,
      untaggedAnswerer: () => null,
      roomMention: () => null,
      agentTags: () => ({}),
      knownRooms: () => [
        { gatewayId: HOME_GROUP.gatewayId, platform: "telegram", chatId: HOME_GROUP.chatId, name: "Rumah", dashboard: false, agents: ["nouva"], people: [], lastActive: 1 },
        { gatewayId: THEIR_GROUP.gatewayId, platform: "telegram", chatId: THEIR_GROUP.chatId, name: "Some group", dashboard: false, agents: ["nora"], people: [], lastActive: 2 },
        { gatewayId: SHARED_GROUP.gatewayId, platform: "telegram", chatId: SHARED_GROUP.chatId, name: "Keluarga", dashboard: false, agents: ["nora", "nouva"], people: [], lastActive: 3 },
      ],
      reachableChats: () => [
        { gatewayId: OWN_DM.gatewayId, chatId: OWN_DM.chatId, platform: "telegram", kind: "dm", people: [{ key: "gading", name: "Gading" }], lastActive: 2 },
        { gatewayId: BUDI.gatewayId, chatId: BUDI.chatId, platform: "telegram", kind: "dm", people: [], lastActive: 3 },
        { gatewayId: THEIR_GROUP.gatewayId, chatId: THEIR_GROUP.chatId, platform: "telegram", kind: "group", title: "Some group", people: [], lastActive: 4 },
        // The admin's own chat with the open bot: a known person's, on an open connection.
        { gatewayId: "telegram:nora", chatId: "814", platform: "telegram", kind: "dm", people: [{ key: "gading", name: "Gading" }], lastActive: 5 },
      ],
    },
  };
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", ACCOUNTS[as]);
    await next();
  });
  for (const register of [registerAgentPublicRoutes, registerConversationRoutes, registerChatListRoutes, registerKnownChatRoutes]) register(app as never, deps as never);
  const ask = async (path: string, who: keyof typeof ACCOUNTS = "admin") => {
    as = who;
    const response = await app.request(path);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { ask, said, access };
}

const chats = (body: Record<string, unknown>) => (body.sessions as SessionSummary[]).map((one) => `${one.gatewayId} ${one.chatId}`).sort();

describe("an open agent's page", () => {
  test("lists its conversations on the connections it owns, newest first: who wrote, what they first asked, and whether they are blocked", async () => {
    const h = await house();
    const { status, body } = await h.ask("/agents/nora/public");
    expect(status).toBe(200);
    const listed = body as unknown as AgentPublic;
    expect(listed.total).toBe(3);
    expect(listed.conversations.map((one) => ({ where: `${one.gatewayId} ${one.chatId}`, kind: one.kind, sender: one.sender, title: one.title }))).toEqual([
      { where: "telegram:nora -200", kind: "group", sender: { id: "9009", name: null, blocked: false }, title: "are you a bot?" },
      { where: "whatsapp:shop 62812@s.whatsapp.net", kind: "private", sender: { id: "62812@s.whatsapp.net", name: null, blocked: true }, title: "berapa harga kopi?" },
      { where: "telegram:nora 7001", kind: "private", sender: { id: "7001", name: "Budi Santoso", blocked: false }, title: "when do you open?" },
    ]);
    // The admin trying their own bot from the dashboard is their own chat, and is not the public's. Nor is another
    // agent's conversation on its connection, which a known person began by naming that agent.
    expect(listed.conversations.map((one) => one.chatId)).not.toContain("web-try");
    expect(listed.conversations.map((one) => one.chatId)).not.toContain("814");
  });

  test("a page at a time, with the way to the next", async () => {
    const h = await house();
    const first = (await h.ask("/agents/nora/public?limit=2")).body as unknown as AgentPublic;
    expect({ shown: first.conversations.map((one) => one.chatId), total: first.total, more: typeof first.nextBefore }).toEqual({ shown: ["-200", "62812@s.whatsapp.net"], total: 3, more: "number" });
    const next = (await h.ask(`/agents/nora/public?limit=2&before=${first.nextBefore}`)).body as unknown as AgentPublic;
    expect({ shown: next.conversations.map((one) => one.chatId), more: next.nextBefore }).toEqual({ shown: ["7001"], more: undefined });
  });

  test("is an admin's to read; an agent that is not open has no public, and one that is not there is not found", async () => {
    const h = await house();
    expect(await h.ask("/agents/nora/public", "operator")).toEqual({ status: 403, body: { error: "admin only" } });
    expect((await h.ask("/agents/nouva/public")).body).toEqual({ conversations: [], total: 0 });
    expect((await h.ask("/agents/ghost/public")).status).toBe(404);
  });
});

describe("a person looked for on an open agent's page", () => {
  const found = async (h: Awaited<ReturnType<typeof house>>, query: string) => {
    const listed = (await h.ask(`/agents/nora/public?q=${encodeURIComponent(query)}`)).body as unknown as AgentPublic;
    return { chats: listed.conversations.map((one) => one.chatId), total: listed.total };
  };

  test("by the name their app gave, whatever its case", async () => {
    const h = await house();
    expect(await found(h, "santoso")).toEqual({ chats: ["7001"], total: 1 });
    expect(await found(h, "BUDI")).toEqual({ chats: ["7001"], total: 1 });
  });

  test("by their number, in a private chat and in a group, where the chat's own id is not theirs", async () => {
    const h = await house();
    expect(await found(h, "62812")).toEqual({ chats: ["62812@s.whatsapp.net"], total: 1 });
    expect(await found(h, "9009")).toEqual({ chats: ["-200"], total: 1 });
    // The app's name in the address is not a number of anybody's: it would find every row of that app.
    expect(await found(h, "telegram")).toEqual({ chats: [], total: 0 });
    // Nor is the domain after a WhatsApp number, in the opener's address or the chat's own id.
    expect(await found(h, "whatsapp")).toEqual({ chats: [], total: 0 });
    expect(await found(h, "s.whatsapp.net")).toEqual({ chats: [], total: 0 });
  });

  test("by the whole address the page shows for one with no name, as it is typed", async () => {
    const h = await house();
    expect(await found(h, "62812@s.whatsapp.net")).toEqual({ chats: ["62812@s.whatsapp.net"], total: 1 });
    expect(await found(h, "62812@lid")).toEqual({ chats: [], total: 0 });
  });

  test("by what they first asked; and a search that finds nobody is an empty page", async () => {
    const h = await house();
    expect(await found(h, "kopi")).toEqual({ chats: ["62812@s.whatsapp.net"], total: 1 });
    expect((await h.ask("/agents/nora/public?q=nobody")).body).toEqual({ conversations: [], total: 0 });
    // Only words, of nothing: the whole list.
    expect((await found(h, "   ")).total).toBe(3);
  });

  test("what is found comes a page at a time too, counted as found", async () => {
    const h = await house();
    // "op": Budi's "when do you open?" and Siti's "kopi", newest first; not the group's question.
    const first = (await h.ask("/agents/nora/public?q=op&limit=1")).body as unknown as AgentPublic;
    expect({ shown: first.conversations.map((one) => one.chatId), total: first.total, more: typeof first.nextBefore }).toEqual({ shown: ["62812@s.whatsapp.net"], total: 2, more: "number" });
    const next = (await h.ask(`/agents/nora/public?q=op&limit=1&before=${first.nextBefore}`)).body as unknown as AgentPublic;
    expect({ shown: next.conversations.map((one) => one.chatId), total: next.total }).toEqual({ shown: ["7001"], total: 2 });
    // A full page may have more after it, as any page does: the next one, asked, has none.
    const last = (await h.ask(`/agents/nora/public?q=op&limit=1&before=${next.nextBefore}`)).body as unknown as AgentPublic;
    expect(last.conversations).toEqual([]);
  });

  test("the household's own list is searched as before: by what was asked and the chat, not by who opened it", async () => {
    const h = await house();
    // "u1" is the admin's address on the dashboard, in no question and no chat id of theirs.
    expect(((await h.ask("/sessions?whose=everyone&q=u1")).body.total as number)).toBe(0);
    expect(chats((await h.ask("/sessions?whose=everyone&q=gaji")).body)).toEqual(["web:dashboard web-g"]);
    // The chat's whole id, its domain too: Siti's chat, among everybody's once Nora is closed.
    const closed = await house({ noraOpen: false });
    expect(chats((await closed.ask("/sessions?whose=everyone&q=whatsapp")).body)).toEqual(["whatsapp:shop 62812@s.whatsapp.net"]);
  });
});

describe("the lists of chats leave an open agent's public out", () => {
  test("everybody's conversations, the groups, and the chats a report can be sent to: the household's alone", async () => {
    const h = await house();
    // What another agent said on an open agent's connection is a known person's, who named that agent there: it stays.
    expect(chats((await h.ask("/sessions?whose=everyone")).body)).toEqual(["telegram:nora -300", "telegram:nora 814", "telegram:nouva -100", "telegram:nouva 814", "web:dashboard web-g", "web:dashboard web-try"]);
    expect(chats((await h.ask("/sessions?agent=nora&whose=everyone")).body)).toEqual(["web:dashboard web-try"]);
    expect(((await h.ask("/sessions?whose=everyone")).body.total as number)).toBe(6);
    // A group only the open agent is in is somebody's own; one the household's other agent is in too is the household's.
    const list = (await h.ask("/chat-list?whose=everyone")).body as unknown as ChatListPayload;
    expect(list.groups.map((group) => group.chatId).sort()).toEqual(["-100", "-300"]);
    // A report goes to a chat somebody known is in: on an open connection that is the admin's own, never a stranger's.
    expect(((await h.ask("/chats")).body.chats as { gatewayId: string; chatId: string }[]).map((chat) => `${chat.gatewayId} ${chat.chatId}`).sort()).toEqual(["telegram:nora 814", "telegram:nouva 814"]);
  });

  test("closed again, its conversations are among everybody's as any agent's are", async () => {
    const h = await house({ noraOpen: false });
    expect(chats((await h.ask("/sessions?whose=everyone")).body)).toContain("telegram:nora 7001");
    const list = (await h.ask("/chat-list?whose=everyone")).body as unknown as ChatListPayload;
    expect(list.groups.map((group) => group.chatId).sort()).toEqual(["-100", "-200", "-300"]);
    expect(((await h.ask("/chats")).body.chats as { chatId: string }[]).map((chat) => chat.chatId).sort()).toEqual(["-200", "7001", "814", "814"]);
    expect((await h.ask("/agents/nora/public")).body).toEqual({ conversations: [], total: 0 });
  });
});
