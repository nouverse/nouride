/**
 * Where this install is, recorded, and the paths its database names followed when it moved (0.8.18, the review's B2).
 *
 * An install is one folder, `.nouride/`, meant to be moved or copied whole: to another disk, another machine, a
 * container's volume. Its database holds absolute paths into it: a job's log, an attachment, a mission's folder, the
 * directory a grant is bound to, a file named in a conversation. Started from somewhere else, a copy found none of them,
 * or the old install's files where the old one was still there. So the folder is recorded (`daemon_state`), and a start
 * that finds itself in another renames every path under the old one (`MovedPaths.rename`) before anything reads one,
 * then records where it is now.
 *
 * The folder is the one that holds `data/`: what the daemon keeps beside it is there (`boot/kept-folders.ts`), and by
 * default the packs and the workspace. A path outside it (a `workspace_dir` on another disk, a repository a mission
 * works in) did not move with it, and stays. An install moved before its first start on 0.8.18 has no record of where it
 * was: that start records where it is, and the paths written before stay as they were.
 */

import { dirname, type SqliteDb } from "@nouride/runtime";
import { createLogger, type GlobalConfig } from "@nouride/shared";
import type { StateRows } from "@/commons/daemon-state.store.ts";
import { MovedPaths } from "@/boot/moved-paths.store.ts";

const log = createLogger("daemon");

/**
 * A folder this near the filesystem's root names too much to rename by: a path is renamed wherever its text holds the
 * folder, and `/data/` is in `/var/data/` too.
 */
const tooNearTheRoot = (path: string) => path.split("/").filter(Boolean).length < 2;

/**
 * Where this install's paths live: the folder that holds `data/` (and beside it the jobs' logs, the attachments, the
 * daemon's HOME), and the workspace and the packs, which `[daemon]` can put anywhere. Each is followed on its own: a
 * `data_dir` set to another disk moves what is under the first, and the workspace that stayed keeps its paths.
 */
interface Places {
  path: string;
  workspace: string;
  agents: string;
}
const KINDS = ["path", "workspace", "agents"] as const;

const isUnder = (folder: string, root: string) => folder === root || folder.startsWith(`${root}/`);

/** A name no path holds, for a folder set aside while the one around it is renamed. */
const ASIDE = "/.nouride-set-aside-";

export function settleInstallRoot(daemon: Pick<GlobalConfig["daemon"], "dataDir" | "workspaceDir" | "agentsDir">, db: SqliteDb, rows: StateRows): void {
  const now: Places = { path: dirname(daemon.dataDir), workspace: daemon.workspaceDir, agents: daemon.agentsDir };
  const was = recordedPlaces(rows.get("install-root"), now);
  if (was !== null && KINDS.every((kind) => was[kind] === now[kind])) return;
  if (was !== null) {
    const moved = KINDS.filter((kind) => was[kind] !== now[kind]);
    const near = moved.filter((kind) => tooNearTheRoot(was[kind]));
    for (const kind of near) {
      log.warn("the install was moved, from a folder too near the filesystem's root to rename by: the paths its database names stay as they were", {
        from: was[kind],
        to: now[kind],
      });
    }
    const followed = moved.filter((kind) => !near.includes(kind));
    if (followed.length > 0) {
      const changed = follow(db, was, now, followed);
      for (const kind of followed) log.info("the install was moved: the paths its database names follow it", { from: was[kind], to: now[kind], rows: changed[kind] });
    }
  }
  rows.set("install-root", JSON.stringify(now));
}

/**
 * Each moved folder's paths renamed under where it is now, the most specific first. A folder that stayed but lies inside
 * one that moved (a `workspace_dir` kept on its disk while `data_dir` went to another, both once under `.nouride/`) is
 * set aside under a name no path holds while that rename passes, and put back after: in one transaction, so nothing ever
 * reads the name it was set aside under.
 */
function follow(db: SqliteDb, was: Places, now: Places, moved: readonly (typeof KINDS)[number][]): Partial<Record<(typeof KINDS)[number], number>> {
  const paths = new MovedPaths(db);
  const order = [...moved].sort((a, b) => was[b].length - was[a].length);
  const stayed = KINDS.filter((kind) => !moved.includes(kind) && moved.some((other) => isUnder(was[kind], was[other]) && was[kind] !== was[other]));
  return db.transaction(() => {
    stayed.forEach((kind, at) => paths.rename(was[kind], `${ASIDE}${at}`));
    const changed: Partial<Record<(typeof KINDS)[number], number>> = {};
    for (const kind of order) changed[kind] = paths.rename(was[kind], now[kind]);
    stayed.forEach((kind, at) => paths.rename(`${ASIDE}${at}`, was[kind]));
    return changed;
  });
}

/**
 * The places the row records, or null for none: a first start on 0.8.18, or a row that is not one. A row that names
 * only the folder (the first builds of 0.8.18) is read as the workspace and the packs where they are now: the folder's
 * rename alone, as those builds did.
 */
function recordedPlaces(json: string | null, now: Places): Places | null {
  try {
    const row = JSON.parse(json ?? "null") as Partial<Record<(typeof KINDS)[number], unknown>> | null;
    const path = row?.path;
    if (typeof path !== "string" || !path.startsWith("/")) return null;
    const placed = (kind: "workspace" | "agents"): string => {
      const value = row?.[kind];
      return typeof value === "string" && value.startsWith("/") ? value : now[kind];
    };
    return { path, workspace: placed("workspace"), agents: placed("agents") };
  } catch {
    return null;
  }
}
