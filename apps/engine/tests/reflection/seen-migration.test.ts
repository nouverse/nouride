/**
 * The migration that begins counting a held kind of work's sightings (`093_skill_learning_seen.sql`): a candidate
 * that existed is given the sightings the audit log still holds of it, so one seen twelve times is not shown as seen
 * once the day the count begins.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase } from "@nouride/runtime";
import { MIGRATIONS } from "@/db/migrations.ts";
import { removeTempDirs, tempDir } from "./harness.ts";

afterEach(removeTempDirs);

describe("the sightings of a kind of work held before they were counted", () => {
  test("are the audit log's rows for it, and one where it holds none", () => {
    const db = openDatabase(join(tempDir(), "nouride.db"));
    for (const migration of MIGRATIONS.filter((one) => one.version < 93)) db.exec(migration.sql);
    const hold = db.prepare("INSERT INTO skill_candidates (name, description, why, agent_id, session_id, first_seen_at, last_seen_at) VALUES (?, 'Use when…', 'why', 'nexa', 'ses_1', 1, 2)");
    for (const name of ["website-feature-development", "image-aspect-reframing"]) hold.run(name);
    const seen = db.prepare("INSERT INTO audit_log (id, timestamp, agent_id, actor, action, details) VALUES (?, ?, 'nexa', 'system', ?, ?)");
    for (let n = 0; n < 12; n += 1) seen.run(`aud_${n}`, n, "skill_candidate_held", JSON.stringify({ skill: "website-feature-development" }));
    // Another action that names it, and a sighting of another: neither is one of its own.
    seen.run("aud_x", 20, "skill_draft_refused", JSON.stringify({ skill: "website-feature-development" }));
    seen.run("aud_y", 21, "skill_candidate_held", JSON.stringify({ skill: "something-else" }));
    db.exec(MIGRATIONS.find((one) => one.version === 93)!.sql);
    const rows = db.prepare<{ name: string; sightings: number }>("SELECT name, sightings FROM skill_candidates ORDER BY name").all();
    expect(rows).toEqual([{ name: "image-aspect-reframing", sightings: 1 }, { name: "website-feature-development", sightings: 12 }]);
    db.close();
  });
});
