/**
 * The daemon's state files moved into the database (0.8.18): at the first start that has `daemon_state`,
 * each JSON file the daemon kept at the root of `data/` is read into its row, unless the row is already there.
 *
 * The files stay where they are. The way back to 0.8.17 is `nouride update --rollback`, which restores the database
 * snapshot taken before the migration, so 0.8.17 starts on a schema without the table and reads its files as it left
 * them; the next upgrade moves them in again, from what 0.8.17 wrote meanwhile. Moved once, recorded in a row of its own:
 * a file read at every start would put 0.8.17's leftovers back over what this build wrote since.
 *
 * A file that does not parse is named, and its state starts empty, as a missing file's always has. Not taken here:
 * `secrets.json` (the secret store's own), `approvals-kept.json` (the approvals' own), `clean-shutdown.json` (written once
 * the database has closed, to vouch for it at the next start: it cannot live inside it) and the appliance's files.
 */

import { join, readTextFileSync, statFile } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { STATE_FILES, type StateRows } from "@/commons/daemon-state.store.ts";

const log = createLogger("daemon");

export function moveStateFiles(dataDir: string, rows: StateRows, now: () => number = Date.now): void {
  if (rows.get("files-moved") !== null) return;
  const moved: string[] = [];
  const unreadable: string[] = [];
  for (const name of STATE_FILES) {
    const path = join(dataDir, `${name}.json`);
    if (rows.get(name) !== null || statFile(path) === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(readTextFileSync(path));
    } catch (err) {
      unreadable.push(name);
      log.warn(`${name}.json could not be read: its state starts empty, as a missing file's does`, { path, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    rows.set(name, JSON.stringify(value));
    moved.push(name);
  }
  rows.set("files-moved", JSON.stringify({ at: now(), moved, unreadable }));
  if (moved.length + unreadable.length > 0) {
    log.info("moved the state files at the root of data/ into the database", { moved: moved.length, files: moved.map((name) => `${name}.json`), hint: "the files stay, for the way back to 0.8.17" });
  }
}
