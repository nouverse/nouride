/**
 * The database check at boot, and the marker a clean shutdown leaves so the next boot can skip it (E10).
 *
 * `PRAGMA quick_check` reads every page. On the live box's 31 MB database that is a fraction of a second; on a
 * Pi with a few hundred MB on an SD card it is the longest single read boot does — and boot did it every time,
 * after a clean stop as after a power cut. A database a clean shutdown closed has every transaction committed
 * and its log checkpointed into the file, so a check the next boot runs finds what the last one would have.
 *
 * So the check runs after a crash, a kill -9 or a power cut, always: the marker is written only once the
 * database has closed, and taken at boot, so a run that dies leaves none. After a clean stop it runs when the
 * last one is a week old, because a clean shutdown says nothing about the disk under it.
 */

import { join, readTextFileSync, removePath, writeBytesSync, type SqliteDb } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";

const log = createLogger("daemon");

const MARKER = "clean-shutdown.json";

/** A clean stop does not vouch for the disk; this long after the last check, check anyway. */
export const CHECK_AT_LEAST_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

interface Marker {
  /** When the daemon that wrote it stopped. */
  stoppedAt: number;
  /** When its database was last checked — at its boot, or carried from the one before. */
  checkedAt: number;
}

export interface BootIntegrity {
  ok: boolean;
  detail: string;
  /** When the database was last checked, for the marker this run leaves at its own clean stop. */
  checkedAt: number;
  /** True when the check was skipped: a clean stop, and a check within the week. */
  skipped: boolean;
}

/** The marker the last run left, taken: read, then removed, so a run that dies cannot leave one behind. */
function takeMarker(dataDir: string): Marker | null {
  const path = join(dataDir, MARKER);
  let marker: Marker | null = null;
  try {
    const parsed = JSON.parse(readTextFileSync(path)) as Partial<Marker>;
    if (typeof parsed.stoppedAt === "number" && typeof parsed.checkedAt === "number") {
      marker = { stoppedAt: parsed.stoppedAt, checkedAt: parsed.checkedAt };
    }
  } catch {
    // No marker, or not one this wrote: the last run did not stop cleanly, as far as anybody can tell.
  }
  removePath(path);
  return marker;
}

/**
 * Check the database, unless the last run stopped cleanly and a check ran within the week. Logged either way —
 * a skipped check is said, so its absence from a log is never a mystery.
 */
export function checkAtBoot(db: SqliteDb, dataDir: string, now = Date.now()): BootIntegrity {
  const marker = takeMarker(dataDir);
  if (marker && now - marker.checkedAt < CHECK_AT_LEAST_EVERY_MS) {
    log.info("database check skipped: the last run stopped cleanly", { checked: new Date(marker.checkedAt).toISOString() });
    return { ok: true, detail: "ok", checkedAt: marker.checkedAt, skipped: true };
  }
  const result = db.integrityCheck();
  if (!result.ok) log.error("database integrity check FAILED: restore from a backup", { detail: result.detail });
  return { ...result, checkedAt: now, skipped: false };
}

/**
 * Said at the very end of a clean shutdown, once the database has closed. A check that failed at boot is not carried
 * forward as one that passed: the next boot checks again.
 */
export function markCleanShutdown(dataDir: string, integrity: Pick<BootIntegrity, "ok" | "checkedAt"> | undefined, now = Date.now()): void {
  if (!integrity?.ok) return;
  try {
    const marker: Marker = { stoppedAt: now, checkedAt: integrity.checkedAt };
    writeBytesSync(join(dataDir, MARKER), new TextEncoder().encode(JSON.stringify(marker)));
  } catch (err) {
    // A marker that cannot be written costs the next boot one check, which is what it did before there was one.
    log.debug("clean-shutdown marker not written", { error: String(err) });
  }
}
