/**
 * Which process supervisor, if any, is keeping this daemon alive.
 *
 * Two things need this answer, and both get it wrong without it:
 *
 * - **`nouride gateway restart` / `nouride restart`.** A supervised daemon restarts by *exiting* and
 *   letting the supervisor bring it back. An unsupervised one that exits is simply gone, so the
 *   same command has to mean two different things and the daemon has to know which.
 * - **`nouride service install`.** Refusing to write a unit file for a daemon that something else is
 *   already respawning is the difference between a working install and two daemons fighting over
 *   one data directory.
 *
 * Detection is by environment marker, the way openclaw does it: a supervisor tells you it is there
 * by what it puts in the child's environment. There is no portable way to ask "who is my parent and
 * will it restart me", and guessing from the process tree is worse than reading the markers a
 * supervisor is contractually obliged to set.
 */

import { runningPlatform } from "@nouride/runtime";

export type SupervisorKind = "systemd" | "launchd" | "procd" | "docker" | "external" | "none";

export interface SupervisorInfo {
  kind: SupervisorKind;
  /** Which marker gave it away, for `nouride doctor` to show. */
  evidence: string | null;
  /**
   * Whether exiting will bring the daemon back.
   *
   * The one fact the restart path needs. `docker` is true only under our own image's entrypoint,
   * which respawns the daemon inside the container. Anywhere else the container's restart policy
   * decides, which we cannot see from inside — so it reports false and the CLI says to use
   * `docker restart` rather than promising something it cannot deliver.
   */
  restartsOnExit: boolean;
}

/**
 * systemd sets `INVOCATION_ID` for every unit it starts, and `JOURNAL_STREAM` when stdout is
 * connected to the journal. `NOURIDE_SERVICE_KIND` is ours, written into the unit we generate, so a
 * unit installed by us is recognised even under a systemd too old for `INVOCATION_ID`.
 */
const SYSTEMD_MARKERS = ["INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID"] as const;

/**
 * launchd exports the job label into its children — but macOS exports `XPC_SERVICE_NAME` into
 * *every* process from a GUI session, set to `0` in an ordinary shell. So presence proves nothing
 * and the value has to match **our** label.
 *
 * Verified the hard way: detecting on presence alone made a daemon started by hand report
 * `launchd`, `nouride restart` answered "launchd is expected to restart it", exited — and nothing
 * restarted it. The guard against restart-as-a-stop-button was defeated by the detection feeding it.
 * Openclaw compares against its expected label for exactly this reason.
 */
const LAUNCHD_LABEL_VARS = ["XPC_SERVICE_NAME", "LAUNCH_JOB_LABEL", "LAUNCH_JOB_NAME"] as const;

/** Must match `LAUNCHD_LABEL` in `unit.ts`; duplicated to keep this module dependency-free. */
const OUR_LAUNCHD_LABEL = "tech.nouverse.nouride";

export interface DetectOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Presence of `/.dockerenv`, injected so this stays testable without a container. */
  inContainer?: boolean;
}

export function detectSupervisor(options: DetectOptions = {}): SupervisorInfo {
  const env = options.env ?? process.env;

  const present = (keys: readonly string[]): string | null =>
    keys.find((key) => (env[key] ?? "").trim().length > 0) ?? null;

  // Ours first: an explicit marker beats an inferred one, and it is the only way to distinguish a
  // unit we generated from an unrelated one that happens to run the same binary.
  //
  // `procd` is OpenWrt's, declared by the init script `nouride service install --kind procd` writes (`procd.ts`),
  // which also runs the update guard. procd sets no marker of its own, so without this a box there read as
  // unsupervised and refused every update as a stop.
  const declared = (env.NOURIDE_SERVICE_KIND ?? "").trim();
  if (declared === "systemd" || declared === "launchd" || declared === "procd") {
    return { kind: declared, evidence: "NOURIDE_SERVICE_KIND", restartsOnExit: true };
  }

  const systemd = present(SYSTEMD_MARKERS);
  if (systemd) return { kind: "systemd", evidence: systemd, restartsOnExit: true };

  // Matched on value, not presence. `XPC_SERVICE_NAME=0` is an ordinary shell, not a launchd job.
  const launchd = LAUNCHD_LABEL_VARS.find((key) => (env[key] ?? "").trim() === OUR_LAUNCHD_LABEL);
  if (launchd) return { kind: "launchd", evidence: launchd, restartsOnExit: true };

  if (options.inContainer) {
    // Our image's entrypoint supervises the daemon itself (`scripts/docker-entrypoint.sh`): an exit
    // it did not cause is a new daemon in the same container a second later, whatever the container's
    // own restart policy says. It says so with this marker.
    if ((env.NOURIDE_CONTAINER_SUPERVISOR ?? "").trim() === "entrypoint") {
      return { kind: "docker", evidence: "NOURIDE_CONTAINER_SUPERVISOR", restartsOnExit: true };
    }
    // Any other container: its restart policy lives outside it. Claiming `restartsOnExit` here
    // would make `nouride restart` a coin flip: with `--restart=no` the daemon just disappears.
    return { kind: "docker", evidence: "/.dockerenv", restartsOnExit: false };
  }

  const external = (env.NOURIDE_SUPERVISOR_MODE ?? "").trim();
  if (external) {
    return { kind: "external", evidence: "NOURIDE_SUPERVISOR_MODE", restartsOnExit: true };
  }

  return { kind: "none", evidence: null, restartsOnExit: false };
}

/**
 * The service manager that fits this host, whether or not one is currently running us.
 *
 * `procd` on a Linux whose init is procd — OpenWrt — which the caller says, having looked: this module reads no files.
 */
export function nativeSupervisorFor(
  platform: string = runningPlatform().platform,
  host: { procd?: boolean } = {},
): "systemd" | "launchd" | "procd" | null {
  if (platform === "linux") return host.procd ? "procd" : "systemd";
  if (platform === "darwin") return "launchd";
  return null;
}
