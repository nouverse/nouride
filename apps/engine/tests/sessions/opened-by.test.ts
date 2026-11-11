/**
 * Who opened a conversation (`sessions.opened_by`): the first person who said something in it, as `[[people]]` writes
 * an id. A private chat is theirs to read (`web/control/whose.ts`), so the daemon's own turns, another agent's and a
 * scheduled job's never open one, and what a later person says never moves it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { personWhoOpened, SessionStore } from "@/modules/sessions/sessions.store.ts";
import { tempDir, turnStore } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

async function stores(manifest = MIGRATIONS) {
  const dir = tempDir("opened-by");
  cleanup.push(() => removePath(dir));
  const db = await openAndMigrate(join(dir, "t.db"), manifest);
  cleanup.push(() => db.close());
  return { db, dir, sessions: new SessionStore(db), turns: turnStore(db) };
}

const DM = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "814" };
const said = (text: string) => [{ role: "user" as const, content: text, timestamp: Date.now() }];

describe("who opened a conversation", () => {
  test("is the first person who said something, as People writes them: the platform, then the account", async () => {
    const { sessions, turns } = await stores();
    turns.begin({ sessionId: sessionIdFor(DM), ...DM, senderId: "814", prompt: "halo" });
    sessions.save(DM, said("halo"), 1);
    expect(sessions.find(sessionIdFor(DM))?.openedBy).toBe("telegram:814");

    const local = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" };
    turns.begin({ sessionId: sessionIdFor(local), ...local, senderId: "usr_1", prompt: "is the disk full?" });
    sessions.save(local, said("is the disk full?"), 1);
    expect(sessions.find(sessionIdFor(local))?.openedBy).toBe("web:usr_1");
  });

  test("is nobody's while only the daemon, another agent or a scheduled job has spoken — and the first person's after", async () => {
    const { sessions, turns } = await stores();
    const id = sessionIdFor(DM);
    turns.begin({ sessionId: id, ...DM, senderId: SYSTEM_SENDER, prompt: "a wake-up" });
    turns.begin({ sessionId: id, ...DM, senderId: "agent:nix", prompt: "nix asks" });
    turns.begin({ sessionId: id, ...DM, senderId: "814", prompt: "the morning line", cause: { via: "schedule", job: "cron_1" } as never });
    sessions.save(DM, said("x"), 1);
    expect(sessions.find(id)?.openedBy).toBeUndefined();

    turns.begin({ sessionId: id, ...DM, senderId: "814", prompt: "halo" });
    sessions.save(DM, said("halo"), 1);
    expect(sessions.find(id)?.openedBy).toBe("telegram:814");
  });

  test("never moves: a second person in the chat later is not who opened it", async () => {
    const { sessions, turns } = await stores();
    const group = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "-100" };
    const id = sessionIdFor(group);
    turns.begin({ sessionId: id, ...group, senderId: "814", prompt: "first" });
    sessions.save(group, said("first"), 1);
    turns.begin({ sessionId: id, ...group, senderId: "999", prompt: "second" });
    sessions.save(group, said("second"), 2);
    expect(sessions.find(id)?.openedBy).toBe("telegram:814");
  });

  test("is the same answer in code, for a conversation whose first turn still runs, as the store's", async () => {
    const { sessions, turns } = await stores();
    const cases = [
      { senderId: "814" },
      { senderId: SYSTEM_SENDER },
      { senderId: "agent:nix" },
      { senderId: "" },
      { senderId: "814", cause: { via: "schedule", job: "cron_1" } },
    ];
    for (const [n, turn] of cases.entries()) {
      const where = { ...DM, chatId: `chat-${n}` };
      turns.begin({ sessionId: sessionIdFor(where), ...where, prompt: "x", ...turn } as never);
      const record = turns.latestForSession(sessionIdFor(where))!;
      sessions.save(where, said("x"), 1);
      expect({ n, code: personWhoOpened(record) }).toEqual({ n, code: sessions.find(sessionIdFor(where))?.openedBy });
    }
  });

  test("of a chat: from any agent's conversation there, or from a running turn before any has a row", async () => {
    const { sessions, turns } = await stores();
    expect(sessions.openerOfChat(DM.gatewayId, DM.chatId)).toBeUndefined();
    turns.begin({ sessionId: sessionIdFor(DM), ...DM, senderId: "814", prompt: "halo" });
    expect(sessions.openerOfChat(DM.gatewayId, DM.chatId)).toBe("telegram:814");
    sessions.save(DM, said("halo"), 1);
    expect(sessions.openerOfChat(DM.gatewayId, DM.chatId)).toBe("telegram:814");
  });

  test("narrows the list to the conversations these people opened, and an empty list to none", async () => {
    const { sessions, turns } = await stores();
    for (const [chatId, senderId] of [["web-1", "usr_1"], ["web-2", "usr_2"]] as const) {
      const where = { agentId: "nouva", gatewayId: "web:dashboard", chatId };
      turns.begin({ sessionId: sessionIdFor(where), ...where, senderId, prompt: "x" });
      sessions.save(where, said("x"), 1);
    }
    expect(sessions.list({ openedBy: ["web:usr_1"] }).map((one) => one.chatId)).toEqual(["web-1"]);
    expect(sessions.count({ openedBy: ["web:usr_1", "web:usr_2"] })).toBe(2);
    expect(sessions.list({ openedBy: [] })).toEqual([]);
    expect(sessions.list().length).toBe(2);
  });
});

describe("the conversations from before", () => {
  test("are filled once from their turns: the first person's, the dashboard's account included; nobody's where none spoke", async () => {
    const before = MIGRATIONS.filter((migration) => migration.version < 83);
    const { db, dir, sessions, turns } = await stores(before);
    const local = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" };
    const job = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "cron:cron_1" };
    turns.begin({ sessionId: sessionIdFor(DM), ...DM, senderId: SYSTEM_SENDER, prompt: "a wake-up" });
    turns.begin({ sessionId: sessionIdFor(DM), ...DM, senderId: "814", prompt: "halo" });
    turns.begin({ sessionId: sessionIdFor(local), ...local, senderId: "usr_1", prompt: "is the disk full?" });
    turns.begin({ sessionId: sessionIdFor(job), ...job, senderId: "814", prompt: "the job", cause: { via: "schedule", job: "cron_1" } as never });
    // Rows as the release before wrote them: no `opened_by` to write yet.
    for (const where of [DM, local, job]) {
      db.prepare("INSERT INTO sessions (id, agent_id, chat_id, gateway, created_at, started_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, 1)").run(sessionIdFor(where), where.agentId, where.chatId, where.gatewayId);
    }
    expect(sessions).toBeDefined();
    db.close();
    cleanup.pop();

    const upgraded = await openAndMigrate(join(dir, "t.db"));
    cleanup.push(() => upgraded.close());
    const after = new SessionStore(upgraded);
    expect(after.find(sessionIdFor(DM))?.openedBy).toBe("telegram:814");
    expect(after.find(sessionIdFor(local))?.openedBy).toBe("web:usr_1");
    expect(after.find(sessionIdFor(job))?.openedBy).toBeUndefined();
  });
});
