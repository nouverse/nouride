/**
 * `daemon_state`: the daemon's own small state, one row each (0.8.18, migration 077, the owner's D6). Each row was a JSON
 * file at the root of `data/`, outside every snapshot and `nouride db restore`. What each holds and how it is read is
 * `commons/daemon-state.ts`; the move from the files, `boot/state-files.ts`.
 */

import { queryDatabaseFile, type SqliteDb } from "@nouride/runtime";

/** The states that were files at the root of `data/` before 0.8.18, each `<name>.json`: a row keeps its file's name. */
export const STATE_FILES = [
  "paused-agents",
  "spend-alerts",
  "alert-cooldowns",
  "morning-lines",
  "agents-seen",
  "external-sessions",
  "external-instructions",
  "external-versions",
  "external-models",
  "external-efforts",
  "cli-accounts",
  "cli-left-running",
  "advisories",
] as const;

/** A row's name: a state that was a file, where this install is (`boot/install-root.ts`), and the record of the move. */
export type StateName = (typeof STATE_FILES)[number] | "install-root" | "files-moved";

/** What reads and writes the rows: the store, or a stand-in a test holds. */
export interface StateRows {
  /** The JSON kept under `name`, or null when there is none. */
  get(name: StateName): string | null;
  /** `value`, JSON, kept under `name` in place of what was. */
  set(name: StateName, value: string): void;
}

export class DaemonStateStore implements StateRows {
  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
  ) {}

  get(name: StateName): string | null {
    return this.db.prepare<{ value: string }>("SELECT value FROM daemon_state WHERE name = ?").get(name)?.value ?? null;
  }

  set(name: StateName, value: string): void {
    this.db
      .prepare("INSERT INTO daemon_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(name, value, this.now());
  }
}

/**
 * One row read off the database file without opening it to write, the daemon running or not: what `nouride doctor` lists
 * of the last boot. Null when there is none, or when the file is not one this can read: no database yet, a schema from
 * before the table, a file this user may not open.
 */
export function stateInFile(dbPath: string, name: StateName): string | null {
  return queryDatabaseFile<{ value: string }>(dbPath, "SELECT value FROM daemon_state WHERE name = ?", name)?.[0]?.value ?? null;
}
