/**
 * The OpenWrt service — procd's init script — written the way `unit.ts` writes systemd's.
 *
 * A box made by the Box flasher on OpenWrt ran an init script of the flasher's own that set HOST and HOME and
 * nothing else. So the daemon read its supervisor as `none` — nothing restarts it on exit — and refused every update
 * as "a stop", silently on a box (`pro-procd-boxes-never-update`). And it ran no update guard: had it updated, a build
 * that crashed at start would have used up procd's five respawns and stayed down, with no way back.
 *
 * Here, so the guard and the marker cannot drift from the systemd unit's: the same `guardScript`, run before every
 * start procd makes, and `NOURIDE_SERVICE_KIND=procd`, which `detectSupervisor` reads as a supervisor that brings the
 * daemon back. Root, like the privileged unit: OpenWrt has no service accounts to speak of, and the box is the agent's.
 */

import { guardScript } from "@/service/update-guard.ts";

export interface ProcdParams {
  /** The command that starts the daemon, `<dir>/nouride start`. */
  execStart: string;
  /** Directory containing `.nouride/`. procd has no working-directory parameter, so the command changes into it. */
  workingDir: string;
  /** Extra environment, e.g. `PORT`. Credentials stay in `.env`, which `nouride start` reads itself. */
  env?: Record<string, string>;
}

/** Where procd looks, and what `nouride service install --kind procd` writes beside the install. */
export const PROCD_SCRIPT = "/etc/init.d/nouride";
export const PROCD_FILE = "nouride.init";

/**
 * The init script.
 *
 * The guard runs in a subshell, `( … )`, and that is load-bearing: it ends with `exit 0` whenever no update is
 * pending, which in the same shell would exit before the daemon started — every boot, not only an update's. A guard
 * that fails is passed over (`;`), as the unit's `ExecStartPre=-` is: it must never be what keeps the daemon down.
 *
 * `respawn 3600 5 5`: a daemon that exits sooner than an hour after starting is a crash, five of them in a row and
 * procd stops — after the guard has had its four starts to put the previous version back. `term_timeout 45` is the
 * unit's `TimeoutStopSec`: the daemon saves in-flight turns on SIGTERM, and procd's own default kills it after five
 * seconds.
 */
export function procdInitScript(params: ProcdParams): string {
  const dir = params.workingDir.replace(/\/+$/, "");
  const env = {
    // The agents' HOME, inside `.nouride/` with the rest of what they keep — as in the systemd unit.
    HOME: `${dir}/.nouride/home`,
    ...params.env,
    // Ours, so `detectSupervisor` knows exiting brings the daemon back, and an update is not a stop.
    NOURIDE_SERVICE_KIND: "procd",
  };
  const command = `(${guardScript(dir)}); cd ${dir} && exec ${params.execStart}`;
  return `#!/bin/sh /etc/rc.common
# Nouride, written by \`nouride service install --kind procd\`. procd keeps it running, as systemd does
# on other boards. Root, like the privileged systemd unit: what gates the agent is its approval level in
# config.toml (\`[security] approvals\`) over the fixed list of what always asks (\`nouride policy\`).
START=99
STOP=10
USE_PROCD=1

start_service() {
	procd_open_instance
	# The update guard first, on every start: while an update is unconfirmed it counts the starts and, on the
	# fourth, puts the previous version back (modules/update/confirm.ts). Then the daemon itself, exec'd so
	# procd supervises it rather than the shell.
	procd_set_param command /bin/sh -c '${command}'
	procd_set_param env ${Object.entries(env).map(([key, value]) => `${key}=${value}`).join(" ")}
	procd_set_param respawn 3600 5 5
	procd_set_param term_timeout 45
	procd_set_param stdout 1
	procd_set_param stderr 1
	procd_close_instance
}
`;
}
