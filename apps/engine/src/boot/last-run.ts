/**
 * Which version last started on this data directory: `<dataDir>/last-run-version`, one line, written once the database
 * is migrated (`openRecorded`).
 *
 * That is this version's one-time work on the data, which is what the upgrade floor asks about. 0.7.x wrote it at
 * ready, after its rewrites on disk, and held it back when one failed; 0.8 has none, and at ready a first boot refused
 * after the database was made — OAuth set on a build without it, in the 0.8.0 upgrade run — left data with no record,
 * which every later boot refused as a release before 0.7.11's. A release upgrades only from its floor — 0.8.0 from the
 * last 0.7.x, every later one from 0.8.0 — and two readers need to know whether that one has run here: `install.sh`,
 * before it installs a release whose checksum file declares a floor (`# >>> upgrade floor` there, which a test holds to
 * this name), and the release itself, at boot. Every version from 0.7.11 writes it; an install with data and no file
 * ran something older.
 *
 * A plain line rather than JSON: a POSIX shell reads it with `head -n 1`. Written atomically, so a reader never sees
 * half of one. A failure is a warning, never a reason to stop serving: the floor's readers treat a missing record as
 * "older", which refuses an upgrade and loses nothing.
 */

import { join, writeTextFileAtomic } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";

const log = createLogger("daemon");

export const LAST_RUN_FILE = "last-run-version";

/**
 * What a 0.7.x boot could not bring forward, one line each — `<dataDir>/carry-forward-pending`, beside the record. Such a
 * boot held the record back and named its leftovers here; 0.8 writes none, and only reads the file, in its refusal
 * (`upgrade-floor.ts`), to say what to fix rather than only which release to install first.
 */
export const PENDING_FILE = "carry-forward-pending";

export async function recordLastRun(dataDir: string, version: string): Promise<void> {
  const path = join(dataDir, LAST_RUN_FILE);
  try {
    await writeTextFileAtomic(path, `${version}\n`);
  } catch (err) {
    log.warn("could not record which version last ran here", {
      path,
      error: err instanceof Error ? err.message : String(err),
      hint: "install.sh and the next release read it before an upgrade, and treat its absence as a release before 0.7.11",
    });
  }
}

/** The database in `dataDir`, opened and migrated — and this version recorded as the last to run here, at once. */
export async function openRecorded(dataDir: string, version: string): Promise<Awaited<ReturnType<typeof openAndMigrate>>> {
  const db = await openAndMigrate(join(dataDir, "nouride.db"));
  await recordLastRun(dataDir, version);
  return db;
}
