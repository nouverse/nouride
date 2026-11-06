/**
 * Where an install lives, and how a relative path in the config file is resolved.
 *
 * Two facts that have each been derived twice and drifted: the config path (`SetupService` used to
 * compute `<dataDir>/config.toml`, which stopped matching the moment the data directory became
 * configurable) and the install root (source checkout, binary install, or a bare `config.toml`
 * beside the executable). One answer each, here.
 */

import { basename, dirname, expandHome, isAbsolute, join, realPath, resolve } from "@nouride/runtime";
import { type GlobalConfig } from "@nouride/shared";


/**
 * The install root: one directory holding `config.toml`, `data/`, `agents/` and `workspace/`.
 *
 * A single name because the whole point is that an install is one thing an operator can back up,
 * move or delete. The three paths inside it are still independently configurable — `workspace_dir`
 * on another disk is a supported arrangement — but this is where they default.
 */
export const INSTALL_ROOT = ".nouride";

/**
 * Where a fresh install writes its config.
 *
 * Exported so the wizard and `nouride setup` write to the file the loader below actually reads. That
 * was one fact in two places once: `SetupService` derived it as `<dataDir>/config.toml`, which stopped
 * being the same path the moment the data directory became configurable on its own.
 */
export function defaultConfigPath(cwd: string = process.cwd()): string {
  return resolve(cwd, INSTALL_ROOT, "config.toml");
}

/**
 * The install a config file belongs to.
 *
 * Relative paths in `config.toml` — `data_dir = "./.nouride/data"` is the default — are relative to
 * the **install root**, not to wherever the process happens to be standing. Resolving them against
 * the cwd is how a daemon quietly creates an empty database beside the real one and reports a
 * healthy boot with no agents and no history — an hour lost, the first time it happened.
 *
 * Two shapes, because a config is found in two places: `<root>/.nouride/config.toml`, where the root
 * is two levels up, and `<root>/config.toml` written by hand beside the binary, where it is one.
 */
export function installRootFor(source: string | null, cwd: string): string {
  if (!source) return cwd;
  const holder = dirname(source);
  return basename(holder) === INSTALL_ROOT ? dirname(holder) : holder;
}

/**
 * Where the running binary's own install lives, if it has one.
 *
 * The CLI is on `PATH` as a symlink — `/usr/local/bin/nouride -> /srv/nouride/nouride` — so the
 * symlink is resolved first: `dirname(process.execPath)` unresolved answers `/usr/local/bin`, where
 * no install lives. That was the whole bug. `nouride status` from any directory but the install one
 * reported no daemon while one ran perfectly, so every command had to be written
 * `cd /srv/nouride && ./nouride …`.
 *
 * Needs no check for whether this is a compiled binary or `bun run`. In a source checkout
 * `process.execPath` is the `bun` executable, and `bun`'s directory holds no config — so the
 * candidate simply never matches. A path that has to be validated anyway does not also need a mode
 * flag saying whether to look.
 */
export function executableRoot(): string {
  try {
    return dirname(realPath(process.execPath));
  } catch {
    return "";
  }
}

/** `p` made absolute against `cwd`, as every path in the config is (`absolutizePaths`). */
export function absolutePath(p: string, cwd: string): string {
  // `~` first: it is what people type, and it is not an absolute path — so resolving it against cwd
  // silently produces `<cwd>/~/...`, a directory that does not exist. Found live, as an agent reporting
  // a file it had been pointed at as missing.
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Relative paths in config are relative to the working directory, and every consumer wants
 * an absolute path. Resolving once here means nothing downstream cares where the daemon was
 * launched from.
 */
export function absolutizePaths(config: GlobalConfig, cwd: string): void {
  const abs = (p: string) => absolutePath(p, cwd);
  config.daemon.dataDir = abs(config.daemon.dataDir);
  config.daemon.agentsDir = abs(config.daemon.agentsDir);
  config.daemon.workspaceDir = abs(config.daemon.workspaceDir);
  // Empty is "the default" and stays empty, rather than becoming the working directory.
  if (config.daemon.backupDir) config.daemon.backupDir = abs(config.daemon.backupDir);
  config.memory.dir = abs(config.memory.dir);

  for (const gateway of config.gateways) {
    if (gateway.sessionDir) gateway.sessionDir = abs(gateway.sessionDir);
    // Unset, a WhatsApp login lives with the rest of the state — backed up with it, and inside the
    // one volume a container mounts. It used to be `./data/whatsapp` from wherever the daemon ran:
    // outside `.nouride` natively, and an unwritable `/app/data` in the image.
    else if (gateway.platform === "whatsapp") gateway.sessionDir = join(config.daemon.dataDir, "whatsapp");
  }
}
