/**
 * What an import does to the database it brought, before the daemon first opens it here: every sign-in ended, and the
 * mark that says this install was imported and is not live yet (`held.ts`).
 */

import { openDatabase, type SqliteDb } from "@nouride/runtime";

/**
 * Every dashboard session ended and every device's token revoked: the accounts are the exported install's, and whoever
 * was signed in to it, on whatever phone or app, signs in to this one again. How many of each.
 */
export function endEverySignIn(db: SqliteDb, now: number): { sessions: number; devices: number } {
  const sessions = db.prepare("DELETE FROM user_sessions").run().changes;
  const devices = db.prepare("UPDATE device_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(now).changes;
  return { sessions: Number(sessions), devices: Number(devices) };
}

/** How many automations are switched on: what waits for "Go live". */
export function automationsOn(db: SqliteDb): number {
  return db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM cron_jobs WHERE enabled = 1").get()?.n ?? 0;
}

/**
 * The database at `dbPath` opened for an export made outside the daemon. Read-write, as a snapshot's statement needs,
 * and safe beside a running daemon: SQLite serialises the two (`db/backup.ts`).
 */
export function openForExport(dbPath: string): { backupTo(path: string): void; userVersion(): number; close(): void } {
  const db = openDatabase(dbPath);
  return { backupTo: (path) => db.backupTo(path), userVersion: () => db.userVersion(), close: () => db.close() };
}
