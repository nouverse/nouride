/**
 * The data directory's lock: taken before anything is written there, and taken over — said, at warn — when it is
 * stale.
 *
 * Stale is the runtime's decision (`acquireLockFile`); what a holder looks like is this daemon's: a live PID holds the
 * lock only when its command line is a Nouride's (`looksLikeDaemon`, the rule `nouride stop` signals by). A container
 * started again after an unclean stop reuses PIDs, so its lock named a live shell or the new daemon itself, and the
 * daemon refused to start on every restart.
 */

import { acquireLockFile, join } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { looksLikeDaemon } from "@/cli/stop.ts";

const log = createLogger("daemon");

export function takeDataDirLock(dataDir: string): { release(): void } {
  const path = join(dataDir, "nouride.lock");
  const lock = acquireLockFile(path, { heldBy: looksLikeDaemon });
  if (lock.tookOver) {
    log.warn("took over a stale lock: no daemon held it", { lock: path, why: lock.tookOver.why });
  }
  return lock;
}
