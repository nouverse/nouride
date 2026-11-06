/**
 * What boot says of where agents' commands run (0.7.19): in a cgroup of their own, or beside the daemon and why. The
 * split itself is `isolateCommands` in the runtime, made as early as boot can be — before the logger is configured, so
 * this is the journal's line for it, said once the logger is.
 */

import type { CommandIsolation } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";

const log = createLogger("daemon");

export function reportCommandIsolation(commands: CommandIsolation): void {
  if (commands.isolated) {
    log.info("agents' commands run in a cgroup of their own", { max_bytes: commands.commandsMaxBytes, daemon_min_bytes: commands.daemonMinBytes, cpu: commands.cpu });
  } else if (commands.systemd) {
    log.warn("agents' commands share the daemon's memory: one that eats it slows the daemon with it", {
      reason: commands.reason,
      hint: "re-run install.sh to rewrite the unit; `nouride service diff` shows what changes",
    });
  } else {
    log.debug("agents' commands run beside the daemon", { reason: commands.reason });
  }
}
