/**
 * What earlier runs kept of a hold that no longer exists is taken off them, on a database of the schema before.
 *
 * A run of a scheduled job used to be held for a message to any chat but its job's, and the hold was kept on the run
 * with "Always allow for this job" beside it. The hold is gone: a person turned the job on. Found the same evening on
 * the live install: the run from before the change still showed its "Held" line and its button under Recent runs,
 * above it a newer run that held nothing, and it read as the hold happening again.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";

const GONE = { keys: ["chat:whatsapp:nouva:2671@lid"], label: "sends a message to the whatsapp one-to-one with Gading", reason: "this run of a scheduled job sends to web:dashboard:web-1, and this sends a message to the whatsapp one-to-one with Gading instead" };
const LOOK = { keys: ["host:x.example"], label: "posts to https://x.example/collect", reason: 'The second look held this: the work is "Triage the issue."; this post (posts to https://x.example/collect): triage never posts anywhere' };

let dir = "";
let db: SqliteDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "held-gone-"));
  db = openDatabase(join(dir, "t.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a database from before the hold was taken away", () => {
  test("its runs lose what that hold kept, and keep what the second look held", async () => {
    await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 87));
    const store = new CronStore({ db, config: DEFAULT_CONFIG.cron, timezone: "UTC" });
    const job = store.create({ agentId: "nouva", name: "Berita", trigger: { kind: "every", everyMs: 60_000 }, payload: { kind: "agentTurn", message: "News." }, target: { gatewayId: "web:dashboard", chatId: "web-1" }, createdBy: "t" });
    const run = db.prepare("INSERT INTO cron_runs (id, job_id, job_name, started_at, finished_at, status, result, held) VALUES (?, ?, ?, ?, ?, 'success', 'Done.', ?)");
    const held: Record<string, string | null> = {
      only: JSON.stringify([GONE]),
      twice: JSON.stringify([GONE, { ...GONE, keys: ["chat:telegram:nouva:814"] }]),
      mixed: JSON.stringify([GONE, LOOK]),
      look: JSON.stringify([LOOK]),
      none: null,
      // Not JSON: nothing this can read, so nothing it may rewrite.
      broken: "[{this run of a scheduled job sends to ",
    };
    Object.entries(held).forEach(([id, value], index) => run.run(id, job.id, job.name, 1_000 + index, 2_000 + index, value));

    await migrate(db);

    const after = Object.fromEntries((db.prepare("SELECT id, held FROM cron_runs").all() as { id: string; held: string | null }[]).map((row) => [row.id, row.held]));
    expect(after.only).toBeNull();
    expect(after.twice).toBeNull();
    // An object still, not its text inside a string: the page reads its label and its keys.
    expect(JSON.parse(after.mixed!)).toEqual([LOOK]);
    expect(JSON.parse(after.look!)).toEqual([LOOK]);
    expect(after.none).toBeNull();
    expect(after.broken).toBe(held.broken!);
    // And as the page is handed them: the run that was only held for that has nothing held. (The row that is not JSON
    // is this test's own, and no reader's to parse.)
    db.prepare("DELETE FROM cron_runs WHERE id = 'broken'").run();
    const runs = Object.fromEntries(store.runs(job.id, 20).map((one) => [one.id, one.held]));
    expect(runs.only).toBeUndefined();
    expect(runs.mixed).toEqual([LOOK]);
  });
});
