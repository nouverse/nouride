/**
 * The snapshot, and the two ways a backup is worse than none.
 *
 * This was the only item on the open list whose loss cannot be undone: persona packs have been
 * copied daily for weeks, and the 26 MB file holding every conversation, turn record, audit entry,
 * cron job and grant had no copy at all. The `.db.bak-*` files on the live box were made by hand.
 *
 * The two failure shapes worth testing are not "does it write a file":
 *
 * 1. **A backup that is silently behind.** `cp` of the live file looks like it works: the database
 *    is three files, and everything committed since the last checkpoint is in the `-wal` sidecar.
 *    A copy of the main file alone restores cleanly and is missing the newest rows.
 * 2. **A restore that produces neither database.** The sidecars belong to the file being replaced.
 *    Leaving one behind means SQLite replays the *old* WAL over the *restored* file, and the result
 *    is a mixture of two databases rather than either one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { backupDatabase, dbBackupDir, listBackups, restoreDatabase, verify } from "@/db/backup.ts";

let dir: string;
let dbPath: string;
let db: SqliteDb;

/** A table with a row count worth checking, standing in for the real schema. */
function seed(handle: SqliteDb, rows: number, from = 0): void {
  handle.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const insert = handle.prepare("INSERT INTO notes (id, body) VALUES (?, ?)");
  for (let i = from; i < from + rows; i += 1) insert.run(i + 1, `note ${i + 1}`);
}

function countNotes(path: string): number {
  const handle = openDatabase(path);
  try {
    return handle.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM notes").get()?.n ?? 0;
  } finally {
    handle.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-db-backup-"));
  dbPath = join(dir, "nouride.db");
  db = openDatabase(dbPath);
  seed(db, 10);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // Already closed by a test that replaced the file under it.
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("taking one", () => {
  test("writes a single file that opens on its own", () => {
    const result = backupDatabase({ db, dataDir: dir, keep: 7 });

    expect(result.path).toBeTruthy();
    expect(result.bytes).toBeGreaterThan(0);

    /**
     * One file, no sidecars — which is what makes recovery a `cp` by somebody who has never read
     * this code.
     *
     * Asserted *before* anything reads it, and that ordering is the point: `openDatabase` sets
     * `PRAGMA journal_mode = WAL`, so merely opening a snapshot to look at it creates the two files
     * this is asserting the absence of. The first version of this test called `countNotes` first
     * and then failed on its own side effect, which is exactly the trap the read-only `verify`
     * exists to avoid.
     */
    expect(existsSync(`${result.path}-wal`)).toBe(false);
    expect(existsSync(`${result.path}-shm`)).toBe(false);
    expect(verify(result.path!).ok).toBe(true);
    expect(existsSync(`${result.path}-wal`)).toBe(false);

    expect(countNotes(result.path!)).toBe(10);
  });

  test("the snapshot is not readable by everybody, because it is the database", () => {
    /**
     * `VACUUM INTO` creates the file under the process umask. On the live box that produced 0644
     * beside a database kept at 0600 — every conversation, the audit log with full tool arguments,
     * and the dashboard's password hashes, readable by any local account on the host.
     *
     * Found by reading `ls -la` on the box after the first real snapshot, which is the argument for
     * this assertion: nothing about the feature working would have shown it.
     */
    const result = backupDatabase({ db, dataDir: dir, keep: 7 });
    // The mode bits only, ignoring the file type.
    expect(statSync(result.path!).mode & 0o777).toBe(0o600);
  });

  test("it includes rows that are still only in the WAL", () => {
    /**
     * The failure `cp` has. These ten rows were written after the database was opened and no
     * checkpoint has run, so they live in `nouride.db-wal`. A copy of the main file alone would
     * restore cleanly and be missing them — which is worse than no backup, because it looks fine.
     */
    seed(db, 10, 100);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const result = backupDatabase({ db, dataDir: dir, keep: 7 });
    expect(countNotes(result.path!)).toBe(20);
  });

  test("a snapshot that fails its check is discarded rather than kept", () => {
    /**
     * A snapshot nobody has opened is a hope. Verifying the *copy* matters most in exactly the case
     * a backup exists for — the original having gone bad — because a broken snapshot left in place
     * lets the retention rule rotate a good one away in favour of it.
     *
     * Through the handle rather than the filesystem: a write that produces a damaged file is not
     * something a temp directory can be talked into, and the alternatives all test the wrong thing.
     * Writing a file where the snapshot is about to go proves nothing — `VACUUM INTO` writes to a
     * `.partial` and the rename overwrites, so it simply succeeds. So the seam is `backupTo`, which
     * is the one method of the port this function calls.
     */
    const junkWriter = {
      ...db,
      backupTo: (path: string) => writeFileSync(path, "this is not a database"),
    };

    const result = backupDatabase({ db: junkWriter, dataDir: dir, keep: 7 });
    expect(result.path).toBeNull();
    expect(result.error).toContain("integrity check");

    // Nothing left where the retention rule or a restore could find it — under either name.
    const written = readdirSync(dbBackupDir(dir));
    expect(written).toEqual([]);
  });

  test("the retention rule keeps the newest and says how many it dropped", () => {
    for (let i = 0; i < 5; i += 1) {
      backupDatabase({ db, dataDir: dir, keep: 3, now: () => 1_700_000_000_000 + i * 86_400_000 });
    }

    const snapshots = listBackups(dir);
    expect(snapshots).toHaveLength(3);
    // Newest first, which is the order somebody picking one to restore wants.
    expect(snapshots[0]!.name > snapshots[1]!.name).toBe(true);
  });

  test("it never throws, whatever the filesystem says", () => {
    // A backup that fails must not take the daemon down. The result carries the failure instead.
    const result = backupDatabase({ db, dataDir: "/proc/nouride-cannot-write-here", keep: 7 });
    expect(result.path).toBeNull();
    expect(result.error).toBeTruthy();
  });
});

describe("verifying one", () => {
  test("a good snapshot checks out and a damaged file does not", () => {
    const result = backupDatabase({ db, dataDir: dir, keep: 7 });
    expect(verify(result.path!).ok).toBe(true);

    const junk = join(dir, "not-a-database.db");
    writeFileSync(junk, "this is not a database");
    const verdict = verify(junk);
    expect(verdict.ok).toBe(false);
    // A file too damaged to open throws before `integrityCheck` runs; the throw is the finding.
    expect(verdict.detail).toBeTruthy();
  });
});

describe("putting one back", () => {
  test("the restored database is the snapshot, and the old one is kept aside", () => {
    const snapshot = backupDatabase({ db, dataDir: dir, keep: 7 }).path!;

    // Move on: ten more rows, so "did the restore actually happen" has a visible answer.
    seed(db, 10, 200);
    expect(countNotes(dbPath)).toBe(20);
    db.close();

    const outcome = restoreDatabase({ from: snapshot, dbPath, now: () => 1_700_000_000_000 });
    expect(outcome.ok).toBe(true);
    expect(countNotes(dbPath)).toBe(10);

    /**
     * And the file it replaced still exists. The most likely mistake here is picking yesterday when
     * you wanted this morning, and that is only recoverable if the wrong choice kept the evidence.
     */
    expect(outcome.ok && outcome.replaced).toBeTruthy();
    /**
     * And it is a database, not two thirds of one.
     *
     * The first version of the restore deleted `nouride.db-wal` after moving the main file aside,
     * which took every row committed since the last checkpoint with it — so the file kept for the
     * undo could not be opened. Caught by asserting the undo rather than the restore, which is why
     * this reads the row count instead of checking the file exists.
     */
    expect(countNotes((outcome as { replaced: string }).replaced)).toBe(20);
  });

  test("the old WAL does not survive to be replayed over the restored file", () => {
    /**
     * The step that is easy to leave out and impossible to notice afterwards. These twenty rows are
     * in the live WAL when the restore runs; if `nouride.db-wal` were left in place, SQLite would
     * replay it over the restored database and the result would be neither snapshot nor original.
     */
    const snapshot = backupDatabase({ db, dataDir: dir, keep: 7 }).path!;
    seed(db, 20, 300);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    db.close();

    expect(restoreDatabase({ from: snapshot, dbPath }).ok).toBe(true);
    expect(countNotes(dbPath)).toBe(10);
  });

  test("a bad snapshot changes nothing at all", () => {
    // Restoring a broken file over a working one turns one problem into two.
    const junk = join(dir, "broken.db");
    writeFileSync(junk, "not a database");
    db.close();

    const outcome = restoreDatabase({ from: junk, dbPath });
    expect(outcome.ok).toBe(false);
    expect(countNotes(dbPath)).toBe(10);
  });

  test("a snapshot that is not there is refused by name", () => {
    const outcome = restoreDatabase({ from: join(dir, "nope.db"), dbPath });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain("no such snapshot");
  });
});

describe("a disk that could not hold it (E14)", () => {
  /**
   * `VACUUM INTO` ran on a nearly full card until the disk was full, then deleted what it wrote — and in between
   * every write the daemon made failed with it. A snapshot needs room for the database twice over.
   */
  test("is not written, and says why — nothing is left behind", () => {
    const { pages, free, pageSize } = db.pageStats();
    const size = (pages - free) * pageSize;
    const result = backupDatabase({ db, dataDir: dir, keep: 7, freeBytes: () => 2 * size - 1 });
    expect(result.path).toBeNull();
    expect(result.error).toContain("not enough free space for a snapshot");
    expect(existsSync(dbBackupDir(dir)) ? readdirSync(dbBackupDir(dir)) : []).toEqual([]);
  });

  test("twice the database is enough, and a filesystem that does not say is no refusal", () => {
    const { pages, free, pageSize } = db.pageStats();
    expect(backupDatabase({ db, dataDir: dir, keep: 7, freeBytes: () => 2 * (pages - free) * pageSize }).path).not.toBeNull();
    expect(backupDatabase({ db, dataDir: dir, keep: 7, freeBytes: () => null, now: () => Date.now() + 2000 }).path).not.toBeNull();
  });
});
