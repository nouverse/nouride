/**
 * How to start and restart the daemon on this machine, said to whoever a command could not reach it for.
 *
 * Which supervisor runs it is read from the files it leaves: the unit, the plist, a container's marker.
 */

import { expandHome, fileExistsSync } from "@nouride/runtime";
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME } from "@/service/unit.ts";

/**
 * How to start the daemon on this machine, for when it cannot be reached.
 *
 * The hint was always "`nouride start`", which on a box where the install made it a service starts a second,
 * unsupervised copy beside the one systemd is restarting — the wrong advice exactly where most installs live.
 * The unit file says which supervisor it is; `paths` is for a test.
 */
export function startHint(paths: SupervisorPaths = {}): string {
  switch (supervisorHere(paths)) {
    case "systemd":
      return "It is a systemd service here: `sudo systemctl start nouride`, and `journalctl -u nouride -n 50` if it does not stay up.";
    case "launchd":
      return `It runs under launchd here: \`launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}\`.`;
    case "container":
      return "Inside a container: start it from the host, `docker compose up -d`.";
    default:
      return "Start it: `nouride start`, or `nouride service install` to keep it running.";
  }
}

/**
 * How to restart the daemon running on this machine — for what it reads only when it starts, as `nouride setup` writes
 * beside a running one (Docker's docs run it so). The same commands the first-run guide gives.
 */
export function restartHint(paths: SupervisorPaths = {}): string {
  switch (supervisorHere(paths)) {
    case "systemd":
      return "sudo systemctl restart nouride";
    case "launchd":
      return `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`;
    case "container":
      return "docker compose restart nouride   (from the host)";
    default:
      return "nouride stop, then nouride start";
  }
}

/** Where the files that say which supervisor runs the daemon are — for a test. */
interface SupervisorPaths {
  systemd?: string;
  launchd?: string;
  container?: string;
}

/** The supervisor the files on this machine say runs the daemon — its unit, its plist, a container. */
function supervisorHere(paths: SupervisorPaths): "systemd" | "launchd" | "container" | null {
  if (fileExistsSync(paths.systemd ?? `/etc/systemd/system/${SYSTEMD_UNIT_NAME}`)) return "systemd";
  if (fileExistsSync(paths.launchd ?? expandHome(`~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`))) return "launchd";
  if (fileExistsSync(paths.container ?? "/.dockerenv")) return "container";
  return null;
}
