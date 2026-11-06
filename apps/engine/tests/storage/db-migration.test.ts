/**
 * Migration tests — verify that applying migrations to a database with existing data
 * preserves that data. Cheap now (one migration), expensive to add retroactively once
 * 002+ exist and a production database has been running.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";

const TEST_DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-migration-"));

/**
 * Highest migration on disk.
 *
 * Read rather than hardcoded: every new migration used to break three assertions that had nothing
 * to do with it, which trains you to update the number without reading why it moved.
 */
const LATEST_VERSION = Math.max(
  ...readdirSync(join(import.meta.dir, "../../src/db/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => Number.parseInt(name.slice(0, 3), 10)),
);

describe("database migrations", () => {
  let db: SqliteDb;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = openDatabase(join(TEST_DIR, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("001_init creates all expected tables", async () => {
    await migrate(db);

    const tables = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);

    expect(tables).toContain("sessions");
    expect(tables).toContain("approvals");
    expect(tables).toContain("audit_log");
    expect(tables).toContain("llm_usage");
    expect(tables).toContain("cron_jobs");
    expect(tables).toContain("users");
    /**
     * `gateway_state` and `message_queue` are asserted *gone*, not present.
     *
     * Both were declared in `001_init` as a design intention that went another way — the queue is in
     * memory and the gateway history never existed — and neither was ever read or written. This
     * assertion used to require `gateway_state`, which made the suite a defender of a dead table.
     * Migration 025 drops them.
     */
    expect(tables).not.toContain("gateway_state");
    expect(tables).not.toContain("message_queue");
    expect(db.userVersion()).toBe(LATEST_VERSION);
  });

  test("migrate is idempotent — running twice does not error", async () => {
    await migrate(db);
    await migrate(db);
    expect(db.userVersion()).toBe(LATEST_VERSION);
  });

  test("data survives re-migration on an already-current database", async () => {
    await migrate(db);

    // Seed representative data in key tables
    const now = Date.now();
    db.prepare(
      "INSERT INTO sessions (id, agent_id, chat_id, gateway, context_token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("ses_1", "nouva", "chat-1", "telegram:nouva", 0, now, now);

    db.prepare(
      "INSERT INTO audit_log (id, timestamp, action, actor) VALUES (?, ?, ?, ?)",
    ).run("aud_1", now, "test_action", "system");

    db.prepare(
      "INSERT INTO approvals (id, agent_id, chat_id, gateway, tool, params, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("apr_1", "nouva", "chat-1", "telegram:nouva", "exec", '{}', now);

    // Re-run migrations — should be a no-op
    await migrate(db);

    // Verify data is intact
    const session = db.prepare<{ id: string }>("SELECT id FROM sessions WHERE id = ?").get("ses_1");
    expect(session?.id).toBe("ses_1");

    const audit = db.prepare<{ id: string }>("SELECT id FROM audit_log WHERE id = ?").get("aud_1");
    expect(audit?.id).toBe("aud_1");

    const approval = db.prepare<{ id: string }>("SELECT id FROM approvals WHERE id = ?").get("apr_1");
    expect(approval?.id).toBe("apr_1");
  });
});

describe("integrity check", () => {
  // Its own directory: `db` and `TEST_DIR` above are scoped to that describe's hooks.
  const DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-integrity-"));

  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  test("a healthy database reports ok", async () => {
    const healthy = openDatabase(join(DIR, "ok.db"));
    try {
      await migrate(healthy);
      expect(healthy.integrityCheck()).toEqual({ ok: true, detail: "ok" });
    } finally {
      healthy.close();
    }
  });

  test("a file too damaged to open fails with a message an operator can act on", () => {
    // Found while writing this test: `openDatabase` throws before `integrityCheck` can run, so the
    // corruption a *page*-level check catches is a different case from a file that is not a database
    // at all. Raw, the latter surfaced as a SQLiteError stack trace at boot.
    const path = join(DIR, "corrupt.db");
    writeFileSync(path, "this is not a database, it is a text file");

    expect(() => openDatabase(path)).toThrow(/Restore it from a backup/);
    expect(() => openDatabase(path)).toThrow(path);
  });

  test("integrityCheck reports rather than throws when the handle cannot answer", () => {
    // An unreadable database cannot report on itself, so a throw inside the check *is* the finding and
    // has to come back as one — a boot that dies here would take a mostly-working daemon offline.
    const closed = openDatabase(join(DIR, "closed.db"));
    closed.close();

    const result = closed.integrityCheck();
    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();
  });
});
