/**
 * Where the scheduled snapshots go: `[daemon] backup_dir`, or `<data_dir>/backups` when it is unset.
 *
 * One answer for the three kinds — the database, the memory vault, the persona packs — so they cannot
 * disagree about where a box keeps its copies, and so `nouride db list` finds what the daemon wrote.
 *
 * ## Never created
 *
 * The directory this names is expected to be on a drive, and a drive that is not mounted leaves an
 * empty mount point behind — on the card the snapshots were moved off. Creating the directory there
 * would fill the card with the very writes the setting exists to keep off it, silently, until the card
 * was full. So a configured directory that is not there is a skipped snapshot, said out loud; only the
 * `db`, `memory` and `agents` folders inside it are ever made. The default is the daemon's own, and is
 * created as it always was.
 *
 * Snapshots taken right before a rewrite — a schema migration, a vault tidy — do not come here. They
 * are the way back from that rewrite, and the way back must not depend on a drive being plugged in.
 */

import { join, statFile } from "@nouride/runtime";
import { createLogger, type GlobalConfig } from "@nouride/shared";

const log = createLogger("backups");

export type BackupDir = { dir: string } | { missing: string };

export function backupDirFor(daemon: Pick<GlobalConfig["daemon"], "dataDir" | "backupDir">): BackupDir {
  if (!daemon.backupDir) return { dir: join(daemon.dataDir, "backups") };
  return statFile(daemon.backupDir)?.isDirectory ? { dir: daemon.backupDir } : { missing: daemon.backupDir };
}

/** The sentence an operator reads when a snapshot was skipped for it — on the CLI and in the log alike. */
export function missingBackupDir(dir: string): string {
  return `[daemon] backup_dir ${dir} is not there. Is the drive mounted? It is never created, so nothing is written until it is.`;
}

/**
 * The directory for one kind of scheduled snapshot, or null while a configured one is missing.
 *
 * Logged when it goes missing and when it comes back, not on every attempt: a drive left unplugged for
 * a week would otherwise be an error line every hour, and the one line that matters is the first.
 */
export function scheduledBackupDir(daemon: Pick<GlobalConfig["daemon"], "dataDir" | "backupDir">, what: string): () => string | null {
  let missing = false;
  return () => {
    const where = backupDirFor(daemon);
    if ("dir" in where) {
      if (missing) log.info(`${what}: backup_dir is back`, { dir: where.dir });
      missing = false;
      return where.dir;
    }
    if (!missing) log.error(`${what} not backed up`, { reason: missingBackupDir(where.missing) });
    missing = true;
    return null;
  };
}
