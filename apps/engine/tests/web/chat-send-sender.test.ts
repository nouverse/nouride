/**
 * Who a message from `/chat/send` is from, for a caller with the token and no account (0.8.1): what it says, except the
 * daemon's own sender — its events pass a pack's allowlist and every rate limit, so a script must not borrow it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { registerChatRoutes } from "@/modules/web/control/routes/chat.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { tempDir, turnStore } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

async function mount() {
  const dataDir = tempDir("chat-sender");
  cleanup.push(() => removePath(dataDir));
  const db = await openAndMigrate(join(dataDir, "test.db"));
  cleanup.push(() => db.close());
  const dispatched: Record<string, unknown>[] = [];
  const deps = {
    local: { id: "web:dashboard", dispatch: (request: Record<string, unknown>) => (dispatched.push(request), { messageId: "msg_1", chatId: String(request.chatId) }) },
    sessions: new SessionStore(db),
    turns: turnStore(db),
    registry: { get: (id: string) => ({ config: { id, enabled: true, displayName: id } }), enabled: () => [{ config: { id: "ren", displayName: "Ren" } }], isPaused: () => false },
    pipeline: { answersWhilePaused: () => false },
    audit: { record: () => undefined },
    ctx: { config: { daemon: { defaultAgent: "ren" } } },
  };
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "token", actor: "token" });
    await next();
  });
  registerChatRoutes(app as never, deps as never);
  const send = async (senderId: string) => {
    const res = await app.request("/chat/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "ren", chatId: "web-1", text: "hi", senderId }) });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };
  return { send, dispatched };
}

describe("a message sent with the token", () => {
  test("is from whom it says, but never from the daemon itself", async () => {
    const h = await mount();
    expect((await h.send("script")).status).toBe(200);
    expect(h.dispatched.at(-1)?.senderId).toBe("script");
    const refused = await h.send("nouride:system");
    expect({ status: refused.status, error: refused.body.error }).toEqual({ status: 400, error: "nouride:system is the daemon's own sender. Name another" });
    expect(h.dispatched).toHaveLength(1);
  });
});
