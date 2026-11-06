/**
 * A conversation's messages as rows (E2, `069_baseline.sql`): a save keeps every row that did not change.
 *
 * The point of the table is what a turn writes. The whole history went through the WAL on every turn while it was one
 * JSON column — a 300 KB conversation is some seventy pages, for the few kilobytes a turn adds. So the store is held
 * here to the rows each save inserts and deletes (`session-writes.ts`) and to the bytes a turn puts in the WAL; and the
 * decision itself, `planKeep`, to each shape a conversation's saves take.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { sessionIdFor, type ChatMessage } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { capStoredTurns } from "@/modules/llm/context.ts";
import { planKeep, SessionStore } from "@/modules/sessions/sessions.store.ts";
import { tempDir } from "../helpers.ts";
import { countWrites } from "./session-writes.ts";

describe("planKeep", () => {
  test("a turn that added messages keeps every stored row", () => {
    expect(planKeep(["a", "b"], ["a", "b", "c", "d"])).toEqual({ from: 0, kept: 2 });
  });

  test("a save of what is stored keeps it all and adds nothing", () => {
    expect(planKeep(["a", "b", "c"], ["a", "b", "c"])).toEqual({ from: 0, kept: 3 });
  });

  test("the oldest turn dropped at the cap keeps the rows after it", () => {
    expect(planKeep(["q1", "a1", "q2", "a2"], ["q2", "a2", "q3", "a3"])).toEqual({ from: 2, kept: 2 });
  });

  test("a compaction's summary differs at the first message, so nothing is kept", () => {
    expect(planKeep(["q1", "a1", "q2", "a2"], ["summary", "q2", "a2"])).toEqual({ from: 0, kept: 0 });
  });

  test("an older message changed — a tool result trimmed — keeps the rows before it", () => {
    expect(planKeep(["q", "call", "result", "answer"], ["q", "call", "result (trimmed)", "answer", "q2"])).toEqual({ from: 0, kept: 2 });
  });

  test("/new keeps nothing", () => {
    expect(planKeep(["a", "b"], [])).toEqual({ from: 0, kept: 0 });
  });

  test("a row without a hash — moved by 055 — matches nothing, so it is written again with one", () => {
    expect(planKeep([null, null], ["a", "b", "c"])).toEqual({ from: 0, kept: 0 });
    expect(planKeep(["a", null], ["a", "b"])).toEqual({ from: 0, kept: 1 });
  });

  test("of two runs that line up, the longer is kept — a repeated question does not anchor the save", () => {
    // "ok" twice: the first run is two long, the one after the dropped turn three.
    expect(planKeep(["q", "ok", "q", "ok", "more"], ["q", "ok", "more", "new"])).toEqual({ from: 2, kept: 3 });
    // A tie goes to the earlier, which keeps the most history.
    expect(planKeep(["x", "y", "x", "y"], ["x", "y"])).toEqual({ from: 0, kept: 2 });
  });
});

describe("SessionStore on rows", () => {
  let dir: string;
  let db: SqliteDb;
  let store: SessionStore;
  let writes: () => { inserted: number; deleted: number };
  const key = { agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" };
  const id = sessionIdFor(key);

  beforeEach(async () => {
    dir = tempDir("session-messages");
    db = await openAndMigrate(join(dir, "data", "nouride.db"));
    store = new SessionStore(db);
    writes = countWrites(db);
  });

  afterEach(() => {
    db.close();
    removePath(dir);
  });

  const user = (content: string): ChatMessage => ({ role: "user", content });
  const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

  test("reads back what was saved, in order", () => {
    const messages = [user("hi"), assistant("hello — ✓ 你好"), user("again")];
    store.save(key, messages, 12);
    expect(store.load(key).messages).toEqual(messages);
    expect(store.load(key).contextTokenCount).toBe(12);
    expect(store.messagesById(id)).toEqual(messages);
  });

  test("a turn writes the messages it added and leaves the rest where they are", () => {
    store.save(key, [user("one"), assistant("1")], 1);
    expect(writes()).toEqual({ inserted: 2, deleted: 0 });
    store.save(key, [user("one"), assistant("1"), user("two"), assistant("2")], 2);

    expect(writes()).toEqual({ inserted: 2, deleted: 0 });
    expect(store.load(key).messages.map((m) => m.content)).toEqual(["one", "1", "two", "2"]);
  });

  test("a save of what is stored writes no message, only the counters", () => {
    store.save(key, [user("one"), assistant("1")], 1);
    writes();
    store.save(key, [user("one"), assistant("1")], 7);

    expect(writes()).toEqual({ inserted: 0, deleted: 0 });
    expect(store.load(key).contextTokenCount).toBe(7);
  });

  test("at the cap, the oldest turn's rows go and the rest stay", () => {
    const turns = [user("q1"), assistant("a1"), user("q2"), assistant("a2")];
    store.save(key, turns, 1);
    writes();
    store.save(key, capStoredTurns([...turns, user("q3"), assistant("a3")], 2), 1);

    expect(writes()).toEqual({ inserted: 2, deleted: 2 });
    expect(store.load(key).messages.map((m) => m.content)).toEqual(["q2", "a2", "q3", "a3"]);
  });

  test("a compaction writes the conversation once, and the turn after it only what it added", () => {
    store.save(key, [user("q1"), assistant("a1"), user("q2"), assistant("a2")], 1);
    writes();
    const compacted = [user("[summary of q1]"), user("q2"), assistant("a2")];
    store.save(key, compacted, 1);
    expect(writes()).toEqual({ inserted: 3, deleted: 4 });

    store.save(key, [...compacted, user("q3")], 1);
    expect(writes()).toEqual({ inserted: 1, deleted: 0 });
    expect(store.load(key).messages.map((m) => m.content)).toEqual(["[summary of q1]", "q2", "a2", "q3"]);
  });

  test("/new empties it, and dates the conversation from now", () => {
    store.save(key, [user("old")], 1);
    db.prepare("UPDATE sessions SET started_at = 1").run();
    store.clear(key);

    expect(store.load(key).messages).toEqual([]);
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM session_messages").get()?.n).toBe(0);
    expect(store.load(key).startedAt).toBeGreaterThan(1);
  });

  test("a message that cannot be read starts the conversation fresh, and the next save replaces the rows", () => {
    store.save(key, [user("q"), assistant("a")], 1);
    db.prepare("UPDATE session_messages SET message = 'not json' WHERE seq = 1").run();

    expect(store.load(key).messages).toEqual([]);
    store.save(key, [user("fresh")], 1);
    expect(db.prepare<{ message: string }>("SELECT message FROM session_messages ORDER BY seq").all()).toEqual([{ message: JSON.stringify(user("fresh")) }]);
  });

  test("deleting the conversation takes its messages", () => {
    store.save(key, [user("q"), assistant("a")], 1);
    expect(store.delete(id)).toBe(true);
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM session_messages").get()?.n).toBe(0);
  });

  test("a save inside the turn's settle commits or rolls back with it", () => {
    store.save(key, [user("q")], 1);
    expect(() =>
      db.transaction(() => {
        store.save(key, [user("q"), assistant("a")], 2);
        throw new Error("the settle failed after the save");
      }),
    ).toThrow("the settle failed");
    expect(store.load(key).messages).toEqual([user("q")]);
    expect(store.load(key).contextTokenCount).toBe(1);
  });

  test("a turn on a 300 KB conversation puts a few pages in the WAL, not the conversation", () => {
    // Sixty exchanges of about 5 KB: what a conversation with tool output reaches in an afternoon.
    const history: ChatMessage[] = [];
    for (let i = 0; i < 60; i += 1) history.push(user(`question ${i}`), assistant(`${"output ".repeat(700)}${i}`));
    store.save(key, history, 80_000);
    db.checkpoint("TRUNCATE");
    expect(db.walSizeBytes()).toBe(0);

    store.save(key, [...history, user("one more"), assistant("short answer")], 80_100);

    const written = db.walSizeBytes();
    // As one column it was the whole document again: ~320 KB of pages. As rows: the two new ones, the index, the
    // conversation's counters — a handful of 4 KB frames.
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(64 * 1024);
  });
});
