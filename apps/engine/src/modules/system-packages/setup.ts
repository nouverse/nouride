/**
 * Can agents on this box install system packages — and if not, what one command would let them.
 *
 * Off unless asked for. `install.sh --allow-packages` sets up `nouride-pkg`, the root service agents
 * install through; an ordinary install does not have it, and nothing nags about that. It comes up
 * only when an agent actually needs a system package: then this names the command to pass on, for
 * the edition that is installed. One line for every public build: the free build carries the LLM gateway,
 * and a re-run of the installer leaves whatever `[nougate] in_process` the install has as it is.
 *
 * Re-running the installer without the flag keeps what an earlier run enabled, so an update never
 * turns it off; `--no-packages` does.
 *
 * Pure: the facts are read by the caller.
 */

/** The installer, as published — `apps/site/src/consts.mjs`, held equal by a test. */
export const INSTALLER_URL = "https://get.nouride.com/install.sh";

const DEFAULT_INSTALL_DIR = "/srv/nouride";

export interface PackageFacts {
  platform: string;
  /** `/.dockerenv`: a container, Pro in a pod included. */
  inContainer: boolean;
  /**
   * Nouride's own image, whose entrypoint serves nouride-pkg and keeps what agents install on the volume
   * (`root/container/`, 0.8.15) — unless the container was started with it off.
   */
  containerService?: boolean;
  /** `/run/systemd/system`: this host booted with systemd. */
  systemd: boolean;
  /** The daemon itself is root — a privileged install, like a flashed Box, which runs the manager directly. */
  daemonRoot?: boolean;
  /** Whether this build carries `nouride-system-packages` at all. */
  plugin: boolean;
  socketPresent: boolean;
  edition: string;
  installDir: string;
}

export type PackageSetup =
  | { state: "ready" }
  /**
   * `command` is null where there is no public installer to name (the licensed editions). `container`: Nouride's image
   * with its package service off, which no installer turns on.
   */
  | { state: "off"; command: string | null; container?: true }
  | { state: "not-applicable"; why: string };

export function packageSetup(facts: PackageFacts): PackageSetup {
  if (!facts.plugin) return { state: "not-applicable", why: "this build does not carry system packages" };
  if (facts.socketPresent) return { state: "ready" };
  if (facts.platform !== "linux") return { state: "not-applicable", why: "system packages are for Linux installs; on macOS Homebrew needs no root" };
  if (facts.inContainer) {
    if (facts.containerService) return { state: "off", command: null, container: true };
    return { state: "not-applicable", why: "in a container a package would be gone when it is recreated: it belongs in the image" };
  }
  if (!facts.systemd) return { state: "not-applicable", why: "the package service needs systemd, and this host does not run it" };
  if (facts.daemonRoot) return { state: "not-applicable", why: "this daemon runs as root and installs packages directly" };
  return { state: "off", command: enableCommand(facts.edition, facts.installDir) };
}

/**
 * The free build's installer for every public edition. `router` is a name no build makes now; still known, it is given
 * the same line rather than `--variant router`, which would also switch the gateway on: this command is about packages
 * and nothing else.
 */
function enableCommand(edition: string, installDir: string): string | null {
  if (edition !== "router" && edition !== "basic" && edition !== "unknown") return null;
  const dir = installDir === DEFAULT_INSTALL_DIR ? "" : ` --dir ${installDir}`;
  return `curl -fsSL ${INSTALLER_URL} | sudo sh -s -- --allow-packages${dir}`;
}

/** What to tell a person who needs a system package here, or null when there is nothing to do. */
export function enableAdvice(setup: PackageSetup): string | null {
  if (setup.state !== "off") return null;
  if (setup.container) {
    return (
      "To let agents install system packages (asking you before every change), start this container as root, the image's " +
      "default, without NOURIDE_SYSTEM_PACKAGES=off, and recreate it (`docker compose up -d`). What they install stays across updates."
    );
  }
  const how = setup.command
    ? `run once, as root: ${setup.command}`
    : "run the install.sh of the release this box was installed from once more, as root, with --allow-packages";
  return `To let agents install system packages (asking you before every change), ${how}. It is safe to re-run: agents, memory and settings stay.`;
}
