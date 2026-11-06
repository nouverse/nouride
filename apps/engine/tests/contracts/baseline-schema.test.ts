/**
 * The baseline against the schema a live install actually has.
 *
 * `069_baseline.sql` replaced 0.8.0's chain — `068_baseline.sql` and `069_missions_automations.sql` — on 2026-10-26,
 * and `068_baseline.sql` had replaced the chain 032 to 068 on 2026-10-24. The generator proved each reproduced its
 * chain, which is necessary and not sufficient: the chain in the repository is not the chain that built any real
 * database. It had been edited. So the first fold was also compared against a live box at 0.7.28, whose schema the
 * chain built over two months: `666471fd5c649d967f0bd3aee9a942a3` by `effectiveSchema` below, 107 objects, which
 * `068_baseline.sql` gave exactly.
 *
 * **The second fold, against the same box.** That box then took 0.8.0, which applied `069_missions_automations.sql` to
 * it. The schema at 69 here is the box's 0.7.28 schema with that migration applied: `068_baseline.sql` and the 069
 * file run in order on an empty database before they were folded, the 0.7.28 hash checked on the first half, and the
 * result hashed the same way — `AT_0_8_0_SHA256`. The migration does not touch `exec_grants`, the one table whose text
 * differs, so the box at 69 holds the same effective schema. It was not read from the box at 69: nothing in this
 * change touched a live machine.
 *
 * **What the comparison found.** One difference across all 107 objects, in a comment inside `exec_grants`: the box
 * says `nourun grants list`, the repository `nouride`. The product was renamed and an already-applied migration was
 * edited to match — the hazard `PRAGMA application_id` now refuses to boot past, caught by the first squash on
 * 2026-09-09 and still there. Harmless, because it is a comment; the effective schema is identical, which is why the
 * hash here is taken with comments stripped.
 *
 * That is also why this test exists rather than trusting the generator. It answers a question the generator cannot:
 * does this file describe the database that is actually running?
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { MIGRATIONS } from "@/db/migrations.ts";

/**
 * The effective schema of the live box at `user_version = 69` under 0.8.0, as the second fold above derives it.
 *
 * The box's own, 2026-10-24 at 68 under 0.7.28, was taken from the database on the box, read-only, with Python's
 * `sqlite3` over `sqlite_master` ordered by type then name, each statement stripped of `--` comments and collapsed to
 * single spaces — `effectiveSchema` below, written twice. Only the hash left that machine: no rows, no column values,
 * nothing about any conversation.
 */
const AT_0_8_0_SHA256 = "b8e6fb230b4bcd33035df4facf7081c7";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Comments stripped, whitespace collapsed: the schema as SQLite would enforce it. */
function effectiveSchema(db: SqliteDb): { objects: number; sha256: string } {
  const rows = db
    .prepare<{ type: string; name: string; sql: string }>(
      `SELECT type, name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name`,
    )
    .all();

  const digest = createHash("sha256");
  for (const row of rows) {
    const normalised = row.sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
    digest.update(`${row.type}:${row.name}:${normalised}\n`);
  }
  return { objects: rows.length, sha256: digest.digest("hex").slice(0, 32) };
}

function applied(): SqliteDb {
  const dir = mkdtempSync(join(tmpdir(), "nouride-baseline-"));
  dirs.push(dir);
  // No PRAGMA here: `openDatabase` already sets `foreign_keys = ON`, and a second copy in a test is
  // both redundant and a portability finding the SQL check is right to report.
  const db = openDatabase(join(dir, "test.db"));
  // The baseline alone: what it is compared against is the box as 0.8.0 left it, and every later
  // migration changes the schema on purpose.
  const baseline = MIGRATIONS[0]!;
  db.exec(baseline.sql);
  db.setUserVersion(baseline.version);
  return db;
}

describe("the baseline", () => {
  test("describes the schema the live install has", () => {
    const db = applied();
    try {
      const schema = effectiveSchema(db);
      expect(schema.objects).toBe(113);
      expect(schema.sha256).toBe(AT_0_8_0_SHA256);
      expect(db.userVersion()).toBe(69);
    } finally {
      db.close();
    }
  });

  test("is the first file, and is the version it replaced", () => {
    // An entry sneaking in below 69 would never apply to a real box, and a baseline renumbered to 1 would strand every
    // existing install on a version nothing follows.
    expect(MIGRATIONS[0]!.name).toBe("069_baseline.sql");
    expect(MIGRATIONS[0]!.version).toBe(69);
    for (const [index, migration] of MIGRATIONS.slice(1).entries()) {
      expect(migration.version).toBe(70 + index);
    }
  });

  test("defines no table nothing reads, by the count the dead-schema check uses", () => {
    /**
     * A weaker restatement of `check-deadcode.ts` on purpose: that script reads the source tree and
     * fails a commit, this asserts the shape survives a squash. A fold that dropped a table would
     * change the count, and a fold that invented one would too — the first attempt at this one dropped
     * `memory_fts_items`, whose name begins like the FTS5 table's own.
     */
    const db = applied();
    try {
      const tables = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => row.name);

      expect(tables).toHaveLength(53);
      expect(tables).toContain("sender_access");
      expect(tables).toContain("memory_fts_items");
      expect(tables).toContain("skill_reads");
      // 0.8.0's: the one table it added, and the one it dropped.
      expect(tables).toContain("missions");
      expect(tables).not.toContain("memory_cursors");
    } finally {
      db.close();
    }
  });
});
