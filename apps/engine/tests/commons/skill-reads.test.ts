/**
 * When a skill was last read outlives the audit rows that recorded it (`AuditLog.skillReads`, `069_baseline.sql`).
 *
 * The weekly review archives a skill nobody has read in 45 days. It used to ask the audit log's newest 5,000 tool
 * calls, which a box keeping 14 days of audit could not answer, and its first live run proposed archiving skills that
 * were read three weeks earlier.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { AuditLog } from "@/commons/audit.store.ts";
import { migrate } from "@/db/index.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 23);
const SKILL = "/srv/nouride/.nouride/agents/skills/monthly-report/SKILL.md";
const OTHER = "/srv/nouride/.nouride/agents/skills/never-opened/SKILL.md";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "nouride-skill-reads-"));
  dirs.push(dir);
  const db: SqliteDb = openDatabase(join(dir, "nouride.db"));
  migrate(db);
  const clock = { now: NOW };
  const audit = new AuditLog(db, () => clock.now);
  const read = (path: string) => audit.record({ action: "tool_exec", agentId: "nouva", details: { tool: "exec", args: { command: `cat ${path}` } } });
  return { db, audit, clock, read };
}

describe("when a skill was last read", () => {
  test("a read is kept after the audit sweep deletes the row that recorded it", () => {
    const h = harness();
    h.read(SKILL);
    h.audit.flush();
    h.clock.now = NOW + 20 * DAY;
    expect(h.audit.sweep(14)).toBe(1);
    expect(h.audit.skillReads([SKILL]).get(SKILL)).toEqual({ readAt: NOW, since: NOW });
  });

  test("the newest read wins, and a read seconds ago is not missed in the buffer", () => {
    const h = harness();
    h.read(SKILL);
    h.audit.flush();
    h.clock.now = NOW + DAY;
    h.read(SKILL);
    expect(h.audit.skillReads([SKILL]).get(SKILL)?.readAt).toBe(NOW + DAY);
  });

  test("a path first asked about is watched from the oldest audit row searched — never from its birth", () => {
    const h = harness();
    // Rows from before skill_reads existed: an exec that mentions no skill, then a read of one.
    const row = h.db.prepare("INSERT INTO audit_log (id, timestamp, actor, action, details) VALUES (?, ?, 'system', 'tool_exec', ?)");
    row.run("aud_1", NOW - 14 * DAY, JSON.stringify({ args: { command: "uptime" } }));
    row.run("aud_2", NOW - 3 * DAY, JSON.stringify({ args: { path: SKILL } }));
    const reads = h.audit.skillReads([SKILL, OTHER]);
    expect(reads.get(SKILL)?.readAt).toBe(NOW - 3 * DAY);
    expect(reads.get(OTHER)).toEqual({ readAt: null, since: NOW - 14 * DAY });
    // Kept: asked again after the audit rows are gone, the watch has not restarted.
    h.clock.now = NOW + 30 * DAY;
    h.audit.sweep(14);
    expect(h.audit.skillReads([OTHER]).get(OTHER)).toEqual({ readAt: null, since: NOW - 14 * DAY });
  });

  test("an audit log with nothing in it starts the watch now", () => {
    const h = harness();
    expect(h.audit.skillReads([OTHER]).get(OTHER)).toEqual({ readAt: null, since: NOW });
  });

  test("only a tool call reads a skill — an approval naming the path does not", () => {
    const h = harness();
    h.audit.record({ action: "approval_answered", details: { command: `cat ${SKILL}` } });
    h.audit.flush();
    expect(h.audit.skillReads([SKILL]).get(SKILL)?.readAt).toBeNull();
  });
});
