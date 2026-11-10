/**
 * What boot says of where agents' commands run (0.7.19): in a cgroup of their own, or beside the daemon and why. The
 * split itself is `isolateCommands` in the runtime, made as early as boot can be — before the logger is configured, so
 * this is the journal's line for it, said once the logger is. And the machine under them, read once here: what the
 * agents are told of it is in the cached part of their prompt, and must not move while the daemon runs.
 */

import type { CommandIsolation } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { atOnceBy, machineAtBoot, machineWords, type Machine } from "@/commons/machine.ts";

const log = createLogger("daemon");

/** The machine as this boot reads it, said in the journal with what it gives where no limit is set. */
export function machineFor(commands: CommandIsolation): Machine {
  const machine = machineAtBoot(commands);
  log.info("machine read", { machine: machineWords(machine), at_once_where_unset: atOnceBy(machine) });
  return machine;
}

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
