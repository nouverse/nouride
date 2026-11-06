/**
 * The manifest in `db/migrations.ts` is the schema now, and this test is what keeps it honest.
 *
 * Migrations used to be discovered by listing `src/db/migrations/` at runtime. That is why
 * `bun build --compile` shipped a broken daemon: a single-file executable has no such directory, the
 * listing came back empty, and `migrate()` reported "schema up to date" on a database at version 0.
 * The first query then failed with `no such table: sender_access`. The manifest cannot be empty, so
 * that failure is gone — but it introduced a new way to be wrong, which is adding a `.sql` file and
 * forgetting the line that imports it. That mistake is invisible at runtime in exactly the same way:
 * the migration simply never runs.
 *
 * So the directory is still read — here, in the tests, where it exists — and compared against the
 * list. In a source checkout these two must agree. The binary carries the SQL and never looks.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "@/db/migrations.ts";
import { openAndMigrate } from "@/db/index.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../../src/db/migrations");
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function sqlFilesOnDisk(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

describe("migration manifest", () => {
  test("lists exactly the .sql files that exist on disk", async () => {
    // Both directions matter. A file with no entry is a migration that silently never applies; an
    // entry with no file is an import that fails the build, which is at least loud.
    expect(MIGRATIONS.map((m) => m.name)).toEqual(await sqlFilesOnDisk());
  });

  test("carries the real contents of each file", async () => {
    // Catches the copy-paste where a new entry reuses the previous import binding — the names would
    // line up perfectly and the wrong SQL would run under the new version number.
    for (const migration of MIGRATIONS) {
      const onDisk = await readFile(join(MIGRATIONS_DIR, migration.name), "utf8");
      expect(migration.sql).toBe(onDisk);
      expect(migration.sql.trim().length).toBeGreaterThan(0);
    }
  });

  test("versions ascend, never repeat, and match the filename", () => {
    /**
     * Ascending and unique, not contiguous from 1. It was contiguous until the first squash, and the
     * assertion had to change with it: the baseline is version 69 and the list has one entry, so
     * "the nth entry is version n" is now false and the property it was protecting is not.
     *
     * What it was protecting is real — `user_version` is one integer compared with `>`, so a
     * duplicate or an out-of-order entry does not error, it *skips*. A migration numbered 9 in a
     * list that already reached 69 would never be reached, and nothing would say so.
     */
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);

    for (const migration of MIGRATIONS) {
      expect(migration.version).toBe(Number.parseInt(migration.name.slice(0, 3), 10));
    }
  });

  test("a fresh database ends at the highest version with its tables present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nouride-migrate-"));
    dirs.push(dir);
    const db = await openAndMigrate(join(dir, "test.db"));

    try {
      // The highest version in the manifest, not the number of entries — the squash separated the
      // two, and a box at 69 with a one-entry list has to land on 69.
      expect(db.userVersion()).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));

      // The table the compiled binary died on. Named explicitly rather than counted, because the
      // symptom was a missing table and a count would have looked fine at zero.
      const tables = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      expect(tables).toContain("sender_access");
    } finally {
      db.close();
    }
  });
});
