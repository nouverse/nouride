/**
 * Finding a conversation in a history longer than a screen.
 *
 * The list was `LIMIT 100`, newest first, with no cursor and no search — so a daemon holding nine
 * hundred conversations showed a hundred, said `100`, and offered no way to reach the rest. The three
 * properties pinned here are what replaced it: the count is the *real* count, the cursor walks back
 * without repeating or skipping a row, and the search matches the thing the list actually displays.
 *
 * That last one is why this test file needs a `TurnStore` at all. What a conversation is *called* is
 * the first question asked in it, which lives in the turn records — a search that only read the
 * sessions table could match nothing a reader can see.
 */

import { sessionIdFor } from "@nouride/shared";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { TurnStore } from "@/modules/turns/turns.store.ts";
import { tempDir, turnStore } from "../helpers.ts";

let db: SqliteDb;
let dataDir: string;
let sessions: SessionStore;
let turns: TurnStore;

/** One conversation, last touched at `at`, opening with `prompt`. */
function conversation(chatId: string, at: number, prompt?: string): string {
  const key = { agentId: "nouva", chatId, gatewayId: "web:dashboard" };
  sessions.save(key, [], 0);
  const id = sessionIdFor(key);
  // `save` stamps `updated_at` with the wall clock; the ordering under test is the daemon's, so it
  // is set explicitly rather than by sleeping between rows.
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(at, id);
  if (prompt) {
    turns.note({
      sessionId: id,
      agentId: "nouva",
      gatewayId: "web:dashboard",
      chatId,
      prompt,
      reply: "ok",
    });
  }
  return id;
}

beforeEach(async () => {
  dataDir = tempDir("session-list");
  db = await openAndMigrate(join(dataDir, "test.db"));
  sessions = new SessionStore(db);
  turns = turnStore(db);
});

afterEach(() => {
  db.close();
  removePath(dataDir);
});

describe("the list", () => {
  test("is newest first and honours its limit", () => {
    conversation("web-1", 1_000);
    conversation("web-2", 3_000);
    conversation("web-3", 2_000);

    expect(sessions.list({ limit: 2 }).map((s) => s.chatId)).toEqual(["web-2", "web-3"]);
  });

  test("counts everything, not the page", () => {
    for (let i = 0; i < 120; i += 1) conversation(`web-${i}`, 1_000 + i);

    // The number the badge shows. It used to be the page size, which read as a fact and was not one.
    expect(sessions.count()).toBe(120);
    expect(sessions.list({ limit: 50 })).toHaveLength(50);
  });

  test("pages back through the whole history without repeating a row", () => {
    for (let i = 0; i < 120; i += 1) conversation(`web-${i}`, 1_000 + i);

    const seen: string[] = [];
    let before: number | undefined;
    for (let page = 0; page < 3; page += 1) {
      const rows = sessions.list({ limit: 50, ...(before ? { before } : {}) });
      seen.push(...rows.map((s) => s.chatId));
      before = rows[rows.length - 1]?.updatedAt;
    }

    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });
});

describe("the search", () => {
  test("matches the opening question, which is what the list shows as a title", () => {
    conversation("web-1", 3_000, "kenapa nox ga bisa? coba cek lognya");
    conversation("web-2", 2_000, "usage lu skrg berapa?");

    const found = sessions.list({ query: "nox" });
    expect(found.map((s) => s.chatId)).toEqual(["web-1"]);
  });

  test("ignores case, and counts what it found", () => {
    conversation("web-1", 3_000, "Fix the Build");
    conversation("web-2", 2_000, "something else");

    expect(sessions.list({ query: "fix the build" }).map((s) => s.chatId)).toEqual(["web-1"]);
    expect(sessions.count({ query: "fix the build" })).toBe(1);
  });

  test("finds a conversation by its chat id too", () => {
    // What somebody pastes when they have the id from a URL or a log line and not the question.
    conversation("web-4242", 3_000, "no mention of the number here");
    expect(sessions.list({ query: "4242" }).map((s) => s.chatId)).toEqual(["web-4242"]);
  });

  test("treats a wildcard as a character, not a wildcard", () => {
    // `%` and `_` are LIKE syntax. An operator searching for `100%` means the string.
    conversation("web-1", 3_000, "disk is at 100% again");
    conversation("web-2", 2_000, "nothing to see");

    expect(sessions.list({ query: "100%" }).map((s) => s.chatId)).toEqual(["web-1"]);
    /**
     * A lone `%` finds the row that literally contains one — not every row.
     *
     * That is the bug this guards. Unescaped, `%` is "match anything", so the search would hand back
     * the entire history and look for all the world like it was not filtering at all.
     */
    expect(sessions.list({ query: "%" }).map((s) => s.chatId)).toEqual(["web-1"]);
  });

  test("pages the same way an unfiltered list does", () => {
    for (let i = 0; i < 4; i += 1) conversation(`web-${i}`, 1_000 + i, `deploy step ${i}`);
    conversation("web-other", 5_000, "unrelated");

    const first = sessions.list({ query: "deploy", limit: 2 });
    const second = sessions.list({ query: "deploy", limit: 2, before: first[1]!.updatedAt });

    expect(first.map((s) => s.chatId)).toEqual(["web-3", "web-2"]);
    expect(second.map((s) => s.chatId)).toEqual(["web-1", "web-0"]);
  });
});
