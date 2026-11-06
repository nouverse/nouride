/**
 * What the daemon keeps that an agent's commands read — its jobs' logs, its attachments, its tools' long output, and
 * the default credentials directory — kept beside `data/`, not in it (0.8.0, the isolation RFC's §3).
 *
 * `data/` is the daemon's alone: the store, the database, the control token. With each agent its own user, a command
 * reaches nothing in it — so what a command is handed a path to (`Full log: …`, an attachment, `Full output: …`) cannot
 * be under it. Each of these is `<folder>/<agent>/…`, and the helper gives `<folder>/<agent>` that agent's group.
 *
 * Moved once, at the first start that finds them inside: the folder, then every row that names a file in it, so an
 * attachment in a conversation's history still opens. A folder that cannot be renamed — `data/` mounted on its own,
 * where moving it out would take it off the volume — stays where it is and is used there, said once.
 */

import { dirExists, dirname, join, listDir, removePath, renamePath, statFile, type SqliteDb } from "@nouride/runtime";
import { createLogger, type GlobalConfig } from "@nouride/shared";
import { MovedPaths } from "@/boot/moved-paths.store.ts";

const log = createLogger("daemon");

export interface KeptFolders {
  jobs: string;
  attachments: string;
  toolOutput: string;
  credentials: string;
}

/** Each folder's name, inside `data/` before 0.8.0 and beside it since. */
const NAMES: Record<keyof KeptFolders, string> = { jobs: "jobs", attachments: "attachments", toolOutput: "tool-output", credentials: "credentials" };

/** Where they belong: what the helper's unit names (`nouride service install`), whatever has been moved yet. */
export function keptFolders(config: GlobalConfig): KeptFolders {
  const beside = (name: string) => join(dirname(config.daemon.dataDir), name);
  return {
    jobs: beside(NAMES.jobs),
    attachments: beside(NAMES.attachments),
    toolOutput: beside(NAMES.toolOutput),
    credentials: config.security.credentialsDir || beside(NAMES.credentials),
  };
}

/** `from` into `to`: renamed whole, or entry by entry where `to` is already there. False when it cannot be renamed. */
function moveFolder(from: string, to: string): boolean {
  try {
    if (!dirExists(to)) {
      renamePath(from, to);
      return true;
    }
    for (const entry of listDir(from)) {
      if (statFile(join(to, entry.name)) === null) renamePath(join(from, entry.name), join(to, entry.name));
    }
    if (listDir(from).length === 0) removePath(from);
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code !== "EXDEV") throw err;
    return false;
  }
}

/**
 * Each folder out of `data/`, with its rows — and where each one is to be used from now on: beside `data/`, or where it
 * is when it could not be moved.
 */
export function settleKeptFolders(config: GlobalConfig, db: SqliteDb): KeptFolders {
  const kept = keptFolders(config);
  const rows = new MovedPaths(db);
  const settled = { ...kept };
  for (const key of Object.keys(NAMES) as (keyof KeptFolders)[]) {
    // Named by the operator: theirs, wherever it is.
    if (key === "credentials" && config.security.credentialsDir) continue;
    const inside = join(config.daemon.dataDir, NAMES[key]);
    const beside = kept[key];
    if (dirExists(inside)) {
      if (!moveFolder(inside, beside)) {
        settled[key] = inside;
        log.warn(`${NAMES[key]} stays inside data/: it is on another filesystem and moving it would take it off`, {
          folder: inside,
          hint: "agents' commands, each its own user, cannot read it there: move it beside data/ by hand",
        });
        continue;
      }
      log.info(`moved ${NAMES[key]} out of data/`, { to: beside, rows: rows.rename(inside, beside) });
    } else if (rows.stillNamed(inside)) {
      log.info(`renamed what still named ${NAMES[key]} inside data/`, { to: beside, rows: rows.rename(inside, beside) });
    }
  }
  return settled;
}
