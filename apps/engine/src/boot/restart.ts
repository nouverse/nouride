/**
 * Ending this process so whatever supervises it starts a new one.
 *
 * One line of code and a file of its own, because it now has two callers and they must
 * not drift: `POST /restart` (the CLI's `nouride restart`, and the dashboard) and the
 * update path, which ends the process on purpose once the new binary is in place.
 *
 * SIGTERM rather than `process.exit()`. The graceful shutdown sequence has to run — a
 * turn in flight dies with unsaved context otherwise, and after an update that is a
 * conversation lost to something the operator asked for.
 */

import { createLogger } from "@nouride/shared";

const log = createLogger("daemon");

export function requestRestart(reason: string): void {
  log.info("restart requested", { reason });
  process.kill(process.pid, "SIGTERM");
}
