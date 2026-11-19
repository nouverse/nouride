/**
 * Migration 092 (`paused_by`, `paused_by_agent` on `missions`) on a database as the release before it left it (schema
 * 91): every mission comes through as it was, with nobody having paused it, and a pause made afterwards is kept with
 * who made it. The migration only adds two columns; no row is changed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removePath(dir);
});

describe("upgrading a v0.8.40 database", () => {
  test("keeps its missions as they were, and takes who paused one from then on", async () => {
    const dir = tempDir("paused-upgrade");
    dirs.push(dir);
    const path = join(dir, "nouride.db");

    const old = await openAndMigrate(path, MIGRATIONS.filter((one) => one.version <= 91));
    expect(old.userVersion()).toBe(91);
    // Two rows as that release wrote them, with the columns it had: one at work, one waiting at a limit.
    const insert = old.prepare(
      `INSERT INTO missions (id, agent_id, started_by, gateway_id, chat_id, goal, title, checks, review_on, accept, status, wait_kind, reason, files, answers, told,
         workdir, untrusted, reviewed, limit_hours, limit_turns, limit_tokens, turns_used, tokens_used, resumes, waited_ms, waiting_since, progress_done, created_at, started_at, updated_at)
       VALUES (?, 'nova', '8142', 'telegram:nova', '8142', ?, ?, '["true"]', 1, 0, ?, ?, ?, '[]', '[]', '[]', '/work/x', 0, 0, 8, 50, 50000000, 3, 12000, 0, 0, ?, 0, 1000, 2000, 3000)`,
    );
    insert.run("msn_running", "write the report", "The report", "running", null, null, null);
    insert.run("msn_limit", "ship it", "Ship it", "waiting", "limit", "its turn limit (50 turns)", 2500);
    const before = old.prepare<Record<string, unknown>>("SELECT * FROM missions ORDER BY id").all();
    expect(before.every((row) => !("paused_by" in row))).toBe(true);
    old.close();

    const db = await openAndMigrate(path);
    try {
      expect(db.userVersion()).toBe(MIGRATIONS.at(-1)!.version);
      // Every column that was there holds what it held; the two new ones are empty.
      const after = db.prepare<Record<string, unknown>>("SELECT * FROM missions ORDER BY id").all();
      expect(after.map(({ paused_by: _by, paused_by_agent: _agent, ...row }) => row)).toEqual(before);
      expect(after.map((row) => [row.paused_by, row.paused_by_agent])).toEqual([[null, null], [null, null]]);

      const store = new MissionStore(db);
      const running = store.get("msn_running")!;
      expect(running).toMatchObject({ status: "running", title: "The report", turnsUsed: 3, pausedBy: null, pausedByAgent: null });
      expect(store.get("msn_limit")).toMatchObject({ status: "waiting", waitKind: "limit", reason: "its turn limit (50 turns)", waitingSince: 2500 });
      // A pause from here on is kept, and read back by a store opened again.
      store.save({ ...running, status: "waiting", waitKind: "paused", reason: "paused by agent nova", pausedBy: "agent nova", pausedByAgent: "nova" });
      expect(new MissionStore(db).get("msn_running")).toMatchObject({ waitKind: "paused", pausedBy: "agent nova", pausedByAgent: "nova" });
    } finally {
      db.close();
    }
  });
});
