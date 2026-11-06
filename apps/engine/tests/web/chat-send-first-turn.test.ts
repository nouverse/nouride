/**
 * A message sent to a conversation whose first turn is still running — `web/control/conversation.ts`.
 *
 * The session row is written when a turn ends, so for the whole of a new conversation's first turn the id the
 * dashboard holds named nothing the route could find. A message sent then — the one that steers the turn — was
 * taken for the start of another chat: the page jumped to an empty conversation, and the turn never saw it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { registerChatRoutes } from "@/modules/web/control/routes/chat.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { tempDir, turnStore } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

async function mount() {
  const dataDir = tempDir("first-turn");
  cleanup.push(() => removePath(dataDir));
  const db = await openAndMigrate(join(dataDir, "test.db"));
  cleanup.push(() => db.close());
  const sessions = new SessionStore(db);
  const turns = turnStore(db);
  const dispatched: Record<string, unknown>[] = [];
  const deps = {
    local: {
      id: "web:dashboard",
      dispatch: (request: Record<string, unknown>) => {
        dispatched.push(request);
        return { messageId: "msg_2", chatId: String(request.chatId) };
      },
    },
    sessions,
    turns,
    registry: {
      get: (id: string) => ({ config: { id, enabled: true, displayName: id } }),
      enabled: () => [{ config: { id: "ren", displayName: "Ren" } }],
      isPaused: () => false,
    },
    audit: { record: () => undefined },
    ctx: { config: { daemon: { defaultAgent: "ren" } } },
  };
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", user: { id: "u1", username: "gading", displayName: "Gading" } });
    await next();
  });
  registerChatRoutes(app as never, deps as never);
  const send = async (body: Record<string, unknown>) => {
    const res = await app.request("/chat/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { sessionId?: string; chatId?: string } };
  };
  return { send, dispatched, sessions, turns };
}

describe("a message sent during a new conversation's first turn", () => {
  test("reaches that conversation — its running turn names the chat before the session row exists", async () => {
    const h = await mount();
    const key = { agentId: "ren", chatId: "web-1", gatewayId: "web:dashboard" };
    const sessionId = sessionIdFor(key);
    h.turns.begin({ sessionId, ...key, prompt: "lu bisa cari deepseek flash v4 vs gpt luna 5.6?" });
    expect(h.sessions.find(sessionId)).toBeNull();

    const sent = await h.send({ sessionId, agent: "ren", text: "cari juga haiku 5.5 deh" });

    expect(sent.status).toBe(200);
    expect(h.dispatched[0]?.chatId).toBe("web-1");
    // The same conversation, so the page stays on it rather than following the answer somewhere new.
    expect(sent.body.sessionId).toBe(sessionId);
  });

  test("an id that names no conversation at all still starts a new one, as before", async () => {
    const h = await mount();

    const sent = await h.send({ sessionId: "sess_nothing", agent: "ren", text: "halo" });

    expect(sent.status).toBe(200);
    expect(String(h.dispatched[0]?.chatId)).toMatch(/^web-\d+$/);
  });
});
