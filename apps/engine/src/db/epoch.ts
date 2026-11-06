/**
 * Which life of the database a cursor into its event stream belongs to — the `epoch` in a stream's `hello` frame
 * (`EVENT_CONTRACT`, `@nouride/shared`).
 *
 * `seq` only moves forward within one life. A database restored from a snapshot — `nouride db restore`, an update's
 * rollback, both through `restoreDatabase` — goes back to an older one, whose next rows reuse numbers a follower
 * already holds past; once enough are written, the follower's cursor no longer looks stale, only wrong. A new epoch
 * says so whatever the numbers say. Kept beside the database rather than in it, so that restoring the file cannot
 * restore its old epoch with it.
 */

import { fileExistsSync, randomHex, readTextFileSync, writeBytesSync } from "@nouride/runtime";

const pathOf = (dbPath: string) => `${dbPath}.epoch`;

/** The database's epoch — made the first time it is asked for. */
export function databaseEpoch(dbPath: string): string {
  try {
    if (fileExistsSync(pathOf(dbPath))) {
      const epoch = readTextFileSync(pathOf(dbPath)).trim();
      if (epoch) return epoch;
    }
  } catch {
    // Unreadable: a new one, which a follower reads as "start over" — the safe mistake.
  }
  return rotateDatabaseEpoch(dbPath);
}

/** A new epoch, for a database that just went back to an older state. */
export function rotateDatabaseEpoch(dbPath: string): string {
  const epoch = randomHex(8);
  try {
    writeBytesSync(pathOf(dbPath), new TextEncoder().encode(`${epoch}\n`), 0o600);
  } catch {
    // A read-only data directory: this process has the epoch, and the next one makes another.
  }
  return epoch;
}
