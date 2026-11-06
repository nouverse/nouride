/**
 * A new conversation is dated by its first message, not by the end of its first turn (0.8.13, found live by
 * live-088.py): the session row is first written as the turn ends, after the turn recorded its usage — so the
 * conversation looked younger than its own first answer, and `/status`, counting usage since it started, said a coding
 * CLI's tokens were "none reported" after it had answered.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
beforeEach(async () => {
  dir = tempDir("nouride-started-");
  db = await openAndMigrate(join(dir, "test.db"));
});
afterEach(() => {
  db.close();
  removePath(dir);
});

test("the first turn's usage is the conversation's: /status counts it once the turn is written", () => {
  const key = { agentId: "kuro", gatewayId: "telegram:kuro", chatId: "555" };
  const asked = Date.now() - 5_000;
  // The CLI answered and reported its tokens mid-turn…
  new UsageStore(db, () => asked + 2_000).record({ agentId: "kuro", model: "codex", provider: "codex", sessionId: sessionIdFor(key), inputTokens: 4_321, outputTokens: 12, cli: true });
  // …and the conversation is written as the turn ends.
  const sessions = new SessionStore(db);
  sessions.save(key, [{ role: "user", content: "hello", timestamp: asked }, { role: "assistant", content: "hi", timestamp: asked + 3_000 }], 10);
  const session = sessions.load(key);
  expect(session.startedAt).toBe(asked);
  expect(new UsageStore(db, () => Date.now()).forSession(session.id, session.startedAt, true)).toMatchObject({ inputTokens: 4_321, outputTokens: 12 });
});

test("a cleared conversation starts again now, whatever its old messages said", () => {
  const key = { agentId: "kuro", gatewayId: "telegram:kuro", chatId: "556" };
  const sessions = new SessionStore(db);
  sessions.save(key, [{ role: "user", content: "old", timestamp: 1_000 }], 1);
  const before = Date.now();
  sessions.clear(key);
  expect(sessions.load(key).startedAt).toBeGreaterThanOrEqual(before);
});
