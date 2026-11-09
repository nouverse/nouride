/**
 * What a room's history says happened to it (`web/control/routes/rooms.ts`), as data as well as a sentence: who started
 * it with which agents, who was added or taken out, and what it was named. The sentence is for the agents; the dashboard
 * says each in its own words from the data, with the agents' names and "You" for the one reading.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath } from "@nouride/runtime";
import type { ChatEvent } from "@nouride/wire";
import { openAndMigrate } from "@/db/index.ts";
import { ChatEventStore } from "@/modules/chat-events/chat-events.store.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { registerRoomRoutes } from "@/modules/web/control/routes/rooms.ts";
import { tempDir } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

async function mount() {
  const dataDir = tempDir("room-events");
  cleanup.push(() => removePath(dataDir));
  const db = await openAndMigrate(join(dataDir, "test.db"));
  cleanup.push(() => db.close());
  const rooms = new RoomStore(db);
  const chatEvents = new ChatEventStore(db);
  const agents = ["nouva", "nestor", "nix"];
  const deps = {
    local: { id: "web:dashboard" },
    rooms,
    chatEvents,
    audit: { record: () => undefined },
    registry: { get: (id: string) => (agents.includes(id) ? { config: { id } } : undefined), enabled: () => agents.map((id) => ({ config: { id } })) },
  };
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "mira", role: "admin", user: { username: "mira" } });
    await next();
  });
  registerRoomRoutes(app as never, deps as never);
  const send = async (method: string, path: string, body?: unknown) =>
    (await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json() as Promise<Record<string, unknown>>;
  const events = (chatId: string): ChatEvent[] => chatEvents.forChat("web:dashboard", chatId) as ChatEvent[];
  return { send, events };
}

describe("a room's history, as data", () => {
  test("started, added to, taken from and named: each event names who and whom, and the name it was given", async () => {
    const h = await mount();
    const made = (await h.send("POST", "/rooms", { agentIds: ["nouva", "nestor"] })) as { room: { chatId: string } };
    const chatId = made.room.chatId;
    await h.send("POST", `/rooms/${chatId}/members`, { agentId: "nix" });
    await h.send("DELETE", `/rooms/${chatId}/members/nestor`);
    await h.send("PUT", `/rooms/${chatId}/title`, { title: "Launch crew" });
    await h.send("PUT", `/rooms/${chatId}/title`, { title: "" });
    const said = h.events(chatId).map((event) => ({ kind: event.kind, actor: event.actor, agentId: event.agentId, details: event.details }));
    // All in one millisecond here, so in no order to rely on.
    expect(said).toHaveLength(5);
    expect(said).toEqual(expect.arrayContaining([
      { kind: "joined", actor: "mira", agentId: undefined, details: { members: ["nouva", "nestor"] } },
      { kind: "joined", actor: "mira", agentId: "nix", details: undefined },
      { kind: "left", actor: "mira", agentId: "nestor", details: undefined },
      { kind: "topic", actor: "mira", agentId: undefined, details: { title: "Launch crew" } },
      { kind: "topic", actor: "mira", agentId: undefined, details: { title: null } },
    ]));
  });
});
