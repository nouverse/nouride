/**
 * `sessions` and `audit_log` grew without bound for the whole of Phase 1 — no TTL, no sweep, no
 * config knob. Both are on the daily retention timer now, and these are the properties that make
 * that safe to leave running unattended on someone's server.
 *
 * The interesting cases are all about what must *survive*: a sweep that is slightly too eager
 * silently deletes the history an operator is relying on, and nothing tells them until they look.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import type { SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { AuditLog } from "@/commons/audit.store.ts";

const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;

let dir: string;
let db: SqliteDb;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-retention-"));
  db = await openAndMigrate(join(dir, "nouride.db"));
});

afterEach(() => {
  db.close();
  removePath(dir);
});

/** A session row with an explicit `updated_at`, which `save()` always sets to now. */
function seedSession(id: string, updatedAt: number): void {
  db.prepare(
    `INSERT INTO sessions (id, agent_id, chat_id, gateway, context_token_count,
                           session_type, status, created_at, updated_at)
     VALUES (?, 'nouva', ?, 'telegram:main', 0, 'main', 'active', ?, ?)`,
  ).run(id, `chat-${id}`, updatedAt - DAY, updatedAt);
}

function sessionIds(): string[] {
  return db
    .prepare<{ id: string }>("SELECT id FROM sessions ORDER BY id")
    .all()
    .map((row) => row.id);
}

describe("SessionStore.sweep", () => {
  test("deletes conversations untouched past the cutoff and keeps the rest", () => {
    const store = new SessionStore(db);
    seedSession("ancient", NOW - 200 * DAY);
    seedSession("stale", NOW - 91 * DAY);
    seedSession("recent", NOW - 3 * DAY);

    expect(store.sweep(90, NOW)).toBe(2);
    expect(sessionIds()).toEqual(["recent"]);
  });

  test("keys on last activity, not on when the conversation started", () => {
    // A chat opened two years ago and used this morning is the least disposable row in the table.
    // `created_at` is deliberately far outside the window here.
    const store = new SessionStore(db);
    db.prepare(
      `INSERT INTO sessions (id, agent_id, chat_id, gateway, context_token_count,
                             session_type, status, created_at, updated_at)
       VALUES ('long-running', 'nouva', 'chat-1', 'telegram:main', 0, 'main', 'active', ?, ?)`,
    ).run(NOW - 700 * DAY, NOW - DAY);

    expect(store.sweep(90, NOW)).toBe(0);
    expect(sessionIds()).toEqual(["long-running"]);
  });

  test("0 keeps everything rather than deleting everything", () => {
    // The off position. A knob whose zero wipes the database is a knob that eventually wipes one.
    const store = new SessionStore(db);
    seedSession("ancient", NOW - 1000 * DAY);

    expect(store.sweep(0, NOW)).toBe(0);
    expect(store.sweep(-1, NOW)).toBe(0);
    expect(sessionIds()).toEqual(["ancient"]);
  });

  test("a row exactly on the boundary survives", () => {
    // `< cutoff`, not `<=`: on the day the retention window closes, the operator still has it.
    const store = new SessionStore(db);
    seedSession("boundary", NOW - 90 * DAY);

    expect(store.sweep(90, NOW)).toBe(0);
    expect(sessionIds()).toEqual(["boundary"]);
  });

  test("a swept conversation comes back empty rather than broken", () => {
    // What the agent sees afterwards: a fresh session, not a missing-row crash.
    const store = new SessionStore(db);
    const key = { agentId: "nouva", chatId: "chat-x", gatewayId: "telegram:main" };
    store.save(key, [{ role: "user", content: "hi" }], 3);
    db.prepare("UPDATE sessions SET updated_at = ?").run(NOW - 400 * DAY);

    expect(store.sweep(90, NOW)).toBe(1);
    expect(store.load(key).messages).toEqual([]);
    // Its messages went with it: rows nothing names any more would stay on the disk for ever.
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM session_messages").get()?.n).toBe(0);
  });
});

describe("AuditLog.sweep", () => {
  /** Entries land through `record`, so the timestamp comes from the injected clock. */
  function auditAt(timestamp: number, action: string): AuditLog {
    const audit = new AuditLog(db, () => timestamp);
    audit.record({ action });
    audit.flush();
    return audit;
  }

  test("deletes entries past the cutoff", () => {
    auditAt(NOW - 60 * DAY, "old");
    auditAt(NOW - 2 * DAY, "fresh");
    const audit = new AuditLog(db, () => NOW);

    expect(audit.sweep(30)).toBe(1);
    expect(audit.recent(10).map((e) => e.action)).toEqual(["fresh"]);
  });

  test("flushes the buffer first, so a pending write is not decided about twice", () => {
    // Buffered entries have their timestamp already; leaving them unflushed would let an old one
    // land *after* the delete and outlive its window by a day.
    const audit = new AuditLog(db, () => NOW - 90 * DAY);
    audit.record({ action: "buffered-and-old" });

    expect(audit.sweep(30, NOW)).toBe(1);
    expect(audit.recent(10)).toEqual([]);
  });

  test("0 keeps everything", () => {
    auditAt(NOW - 5000 * DAY, "ancient");
    const audit = new AuditLog(db, () => NOW);

    expect(audit.sweep(0)).toBe(0);
    expect(audit.recent(10).map((e) => e.action)).toEqual(["ancient"]);
  });

  test("a failed sweep is logged, not thrown", async () => {
    // It runs on a background timer during normal operation. A cleanup that can kill the daemon it
    // is cleaning up after is worse than an unswept table. Its own database, closed underneath it,
    // because the shared one still has an `afterEach` to survive.
    const doomed = await openAndMigrate(join(dir, "doomed.db"));
    const audit = new AuditLog(doomed, () => NOW);
    doomed.close();

    expect(audit.sweep(30)).toBe(0);
  });
});
