/**
 * A message to a paused agent, from the dashboard's chat — `web/control/routes/chat.ts`.
 *
 * Refused up front, since a paused agent starts no turn and a client told 200 would wait for a record never written.
 * But `/start` was refused with it: a person who typed `/stop` in the dashboard's chat could not type `/start` after it,
 * and was told to resume the agent from another page. Found on 0.7.15's end-to-end run, where Telegram's `/start`
 * worked and the dashboard's did not. A command the agent still answers goes through now; words still do not.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { HookRegistry } from "@/modules/hooks/registry.ts";
import { registerChatRoutes } from "@/modules/web/control/routes/chat.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { tempDir, turnStore } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/** The commands as the daemon has them: the registry's own list, nothing restated here. */
const hooks = new HookRegistry({} as never);

async function mount() {
  const dataDir = tempDir("chat-paused");
  cleanup.push(() => removePath(dataDir));
  const db = await openAndMigrate(join(dataDir, "test.db"));
  cleanup.push(() => db.close());
  const dispatched: Record<string, unknown>[] = [];
  const deps = {
    local: {
      id: "web:dashboard",
      dispatch: (request: Record<string, unknown>) => {
        dispatched.push(request);
        return { messageId: "msg_1", chatId: String(request.chatId) };
      },
    },
    sessions: new SessionStore(db),
    turns: turnStore(db),
    registry: {
      get: (id: string) => ({ config: { id, enabled: true, displayName: id } }),
      enabled: () => [{ config: { id: "ren", displayName: "Ren" } }],
      isPaused: () => true,
    },
    pipeline: { answersWhilePaused: (text: string) => hooks.answersWhilePaused(text) },
    audit: { record: () => undefined },
    ctx: { config: { daemon: { defaultAgent: "ren" } } },
  };
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", user: { id: "u1", username: "gading", displayName: "Gading" } });
    await next();
  });
  registerChatRoutes(app as never, deps as never);
  const send = async (text: string) => {
    const res = await app.request("/chat/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "ren", chatId: "web-1", text }) });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };
  return { send, dispatched };
}

describe("a paused agent, written to from the dashboard's chat", () => {
  test("is sent /wake and /start — and the other commands it still answers — but not words", async () => {
    const h = await mount();

    for (const command of ["/wake", "/start", "/status", "/help"]) expect((await h.send(command)).status).toBe(200);
    expect(h.dispatched.map((request) => request.text)).toEqual(["/wake", "/start", "/status", "/help"]);

    const words = await h.send("are you there?");
    expect(words.status).toBe(409);
    expect(words.body.error).toBe("ren is asleep. Wake it from Agents, or send /wake");
    // A command it does not answer while paused waits for /start, as words do.
    expect((await h.send("/new")).status).toBe(409);
    expect(h.dispatched).toHaveLength(4);
  });
});

describe("which commands a paused agent answers", () => {
  test("those that work while paused, read from the command itself — arguments and a bot's name included", () => {
    expect(hooks.answersWhilePaused("/start")).toBe(true);
    expect(hooks.answersWhilePaused("  /status  ")).toBe(true);
    expect(hooks.answersWhilePaused("/start@nouride_bot please")).toBe(true);
    expect(hooks.answersWhilePaused("/new")).toBe(false);
    expect(hooks.answersWhilePaused("/stop")).toBe(false);
    expect(hooks.answersWhilePaused("start")).toBe(false);
    expect(hooks.answersWhilePaused("")).toBe(false);
  });
});
