/**
 * Whether this install's daemon is running — asked of the process its lock names, not of the lock file alone.
 *
 * A lock outlives a killed process, so the file alone says "running" after every crash and refuses every real restore;
 * and a pid is reused, so the command line has to agree that this is a Nouride (`looksLikeDaemon`, the rule
 * `nouride stop` signals by). Not asked of the daemon either: one wedged enough not to answer `/health` still holds
 * the database, and "cannot reach it" must never read as "it is not running".
 */

import { fileExistsSync, isProcessAlive, join, processCommandLine, readTextFileSync } from "@nouride/runtime";
import { looksLikeDaemon } from "@/cli/stop.ts";

/** The pid of the daemon running on `dataDir`, or null when none is. */
export function runningDaemon(dataDir: string): number | null {
  const lockPath = join(dataDir, "nouride.lock");
  const holder = fileExistsSync(lockPath) ? Number(readTextFileSync(lockPath).trim()) : 0;
  if (!Number.isInteger(holder) || holder <= 0 || !isProcessAlive(holder)) return null;
  return looksLikeDaemon(processCommandLine(holder) ?? "") ? holder : null;
}
