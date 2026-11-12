/**
 * The page a message was written from, through `/chat/send`: handed on with the message when the body names one, and a
 * message whose `page` is not a page is sent all the same, without one. What the model is then told is
 * `pipeline/page-note.test.ts`.
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
  const dataDir = tempDir("chat-page");
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
  const send = async (extra: Record<string, unknown>) => {
    const res = await app.request("/chat/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "ren", chatId: "web-1", text: "what about this one?", ...extra }) });
    return res.status;
  };
  return { send, dispatched };
}

describe("the page a message was written from", () => {
  test("goes on with the message, as the body said it", async () => {
    const h = await mount();
    const page = { path: "/dashboard/missions/msn_1", title: "Missions", subject: "Move the shop" };
    expect(await h.send({ page })).toBe(200);
    expect(h.dispatched.at(-1)?.page).toEqual(page);
  });

  test("a message that names none, or names something that is no page, is sent without one", async () => {
    const h = await mount();
    for (const page of [undefined, "/dashboard/missions", { title: "Missions" }, { path: "/dashboard/missions", title: 7 }]) {
      expect(await h.send(page === undefined ? {} : { page })).toBe(200);
      expect("page" in h.dispatched.at(-1)!).toBe(false);
    }
    expect(h.dispatched).toHaveLength(4);
  });
});
