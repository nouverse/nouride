/**
 * Who said what, in a conversation on a chat app (`web/control/senders.ts`): a turn there carries its asker's name —
 * People's, else the name their app gives them — and a group's transcript carries what people said in it, answered or
 * not, from its room log. The dashboard's own conversations carry neither: whoever asked there is the person reading.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import type { Transcript } from "@nouride/wire";
import { openAndMigrate } from "@/db/index.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { registerChatRoutes } from "@/modules/web/control/routes/chat.ts";
import { tempDir, turnStore } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

async function mount() {
  const dataDir = tempDir("senders");
  cleanup.push(() => removePath(dataDir));
  const db = await openAndMigrate(join(dataDir, "test.db"));
  cleanup.push(() => db.close());
  const sessions = new SessionStore(db);
  const turns = turnStore(db);
  const roomMessages = new RoomMessageStore(db);
  const deps = {
    local: { id: "web:dashboard" },
    sessions,
    turns,
    roomMessages,
    audit: { record: () => undefined },
    // Someone met only in a private chat, named by the request they made to talk to the agent.
    access: { get: (gatewayId: string, senderId: string) => (gatewayId === "telegram:nestor" && senderId === "777" ? { senderName: "Budi" } : null) },
    ctx: { config: { daemon: {}, people: [{ key: "gading", name: "Gading", ids: ["telegram:814", "web:u1"] }] } },
  };
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "viewer", role: "viewer", user: { username: "viewer" } });
    await next();
  });
  registerChatRoutes(app as never, deps as never);
  const get = async <T>(path: string) => (await (await app.request(path)).json()) as T;
  /** A finished exchange asked by `senderId`, its session written as a finished turn writes it. */
  const asked = (where: { agentId: string; gatewayId: string; chatId: string }, senderId: string, prompt: string) => {
    const id = turns.begin({ sessionId: sessionIdFor(where), ...where, prompt, senderId });
    turns.finish(id, { status: "done", reply: "on it" });
    sessions.save(where, [{ role: "user", content: prompt }, { role: "assistant", content: "on it" }], 10);
    return sessionIdFor(where);
  };
  return { get, asked, turns, roomMessages };
}

describe("a conversation on a chat app, read in the dashboard", () => {
  test("a group: each turn under its asker's name, People's first, and what people said that nobody answered", async () => {
    const h = await mount();
    const group = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "-100" };
    h.roomMessages.record({ id: "m1", gatewayId: group.gatewayId, chatId: group.chatId, senderId: "814", senderName: "gading_n", text: "@nouva deploy?", at: 1 });
    h.roomMessages.record({ id: "m2", gatewayId: group.gatewayId, chatId: group.chatId, senderId: "999", senderName: "Rani", text: "thanks everyone", at: 2 });
    h.roomMessages.record({ id: "m3", gatewayId: group.gatewayId, chatId: group.chatId, senderId: "999", senderName: "Rani", text: "@nouva and the backup?", at: 3 });
    h.asked(group, "814", "@nouva deploy?");
    const session = h.asked(group, "999", "@nouva and the backup?");

    const transcript = await h.get<Transcript>(`/sessions/${encodeURIComponent(session)}/turns`);
    expect(transcript.turns.map((turn) => turn.senderName)).toEqual(["Gading", "Rani"]);
    // Every line people said, the one nobody answered among them, each under the dashboard's name for them.
    expect((transcript.messages ?? []).map((message) => [message.senderName, message.text])).toEqual([
      ["Gading", "@nouva deploy?"],
      ["Rani", "thanks everyone"],
      ["Rani", "@nouva and the backup?"],
    ]);
  });

  test("a private chat: its turns under the person's name, and no room log", async () => {
    const h = await mount();
    const session = h.asked({ agentId: "nestor", gatewayId: "telegram:nestor", chatId: "814" }, "814", "compare the harnesses");
    const transcript = await h.get<Transcript>(`/sessions/${encodeURIComponent(session)}/turns`);
    expect(transcript.turns[0]?.senderName).toBe("Gading");
    expect(transcript.messages).toEqual([]);
  });

  test("a private chat with someone not under People: the name their app gave when they asked to talk", async () => {
    const h = await mount();
    const session = h.asked({ agentId: "nestor", gatewayId: "telegram:nestor", chatId: "777" }, "777", "halo");
    const transcript = await h.get<Transcript>(`/sessions/${encodeURIComponent(session)}/turns`);
    expect(transcript.turns[0]?.senderName).toBe("Budi");
  });

  test("the live feed says who asked the turn at work", async () => {
    const h = await mount();
    const where = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "-100" };
    h.roomMessages.record({ id: "m1", gatewayId: where.gatewayId, chatId: where.chatId, senderId: "999", senderName: "Rani", text: "@nouva status?", at: 1 });
    h.turns.begin({ sessionId: sessionIdFor(where), ...where, prompt: "@nouva status?", senderId: "999" });
    const live = await h.get<{ turn: { senderName?: string } | null }>(`/sessions/${encodeURIComponent(sessionIdFor(where))}/live?after=0`);
    expect(live.turn?.senderName).toBe("Rani");
  });

  test("the dashboard's own conversation names nobody: the one asking is the person reading", async () => {
    const h = await mount();
    const session = h.asked({ agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" }, "u1", "hello");
    const transcript = await h.get<Transcript>(`/sessions/${encodeURIComponent(session)}/turns`);
    expect(transcript.turns[0]?.senderName).toBeUndefined();
    expect(transcript.messages).toEqual([]);
  });
});
