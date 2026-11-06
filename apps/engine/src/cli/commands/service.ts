import { expandHome, fileExists, join, readTextFileIfExists, runningPlatform, statFile, writeTextFileAtomic, totalMemoryBytes } from "@nouride/runtime";
import { SYSTEM_KEY_FILE } from "@nouride/secrets";
import { flagValue, hasFlag } from "@/cli/args.ts";
import { connect } from "@/cli/client.ts";
import type { StatusResponse } from "@/cli/wire.ts";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, emit, fail, say, usageError } from "@/cli/ui.ts";
import { unknownAction } from "@/cli/usage.ts";

/**
 * `nouride service` — install, remove or inspect the unit that keeps the daemon alive.
 *
 * Writes the file and prints the two commands that activate it rather than running them itself.
 * Enabling a system service is a privileged, host-changing action; a CLI that silently
 * `systemctl enable`s something is a CLI you cannot safely run to see what it would do.
 */
/** The helper's units, from the config in the working directory (`boot/agent-users.ts` reads the same folders). */
async function helperUnitsFor(user: string): Promise<Record<string, string>> {
  const { loadConfig } = await import("@/cli/load-config.ts");
  const { helperUnits } = await import("@nouride/isolation");
  const { helperFolders } = await import("@/boot/agent-users.ts");
  const { keptFolders } = await import("@/boot/kept-folders.ts");
  const { config } = await loadConfig();
  return helperUnits({ user, group: user, folders: helperFolders(config, keptFolders(config)) });
}

/** Where install.sh keeps the secret store's key on a Mac: outside the install folder (0.8.19). */
const MAC_KEY_FILE = "~/.config/nouride/nouride.env";

export async function service(args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  const { detectSupervisor, nativeSupervisorFor } = await import("@/service/supervisor.ts");
  const {
    systemdUnit,
    launchdPlist,
    assertNotRoot,
    defaultExecStart,
    SYSTEMD_UNIT_NAME,
    LAUNCHD_LABEL,
  } = await import("@/service/unit.ts");
  const { compareInstalledUnit, INSTALLED_UNIT, staleSizes, systemdVersion, versionOf } = await import("@/service/drift.ts");

  if (action === "diff") {
    /**
     * The installed unit against what this version writes, directive by directive. Updates replace the binary and
     * never the unit, so a unit keeps what it was installed with until `install.sh` runs again — and only `doctor`'s
     * one `KillMode` check said so, for one directive.
     */
    const installed = await readTextFileIfExists(INSTALLED_UNIT).catch(() => null);
    const compared = compareInstalledUnit(installed, (await systemdVersion()) ?? undefined, statFile(SYSTEM_KEY_FILE) ? SYSTEM_KEY_FILE : undefined);
    // The sizes measured when it was written, against this machine now: a resized container keeps its old ceiling.
    const sizes = installed === null ? [] : staleSizes(installed, { memoryHighBytes: softMemoryCeiling(), tmpSizeBytes: tmpfsCeiling() });
    emit({ unit: INSTALLED_UNIT, ours: compared !== null, added: compared?.added ?? [], removed: compared?.removed ?? [], privileged: compared?.privileged ?? false, staleSizes: sizes });
    if (!compared) return say(`${DIM}no unit of ours at ${INSTALLED_UNIT} to compare${RESET}`);
    for (const note of sizes) say(`${YELLOW}!${RESET} ${note} ${DIM}(re-run install.sh to measure again)${RESET}`);
    if (compared.added.length === 0 && compared.removed.length === 0) {
      return say(`${GREEN}✓${RESET} ${INSTALLED_UNIT} is the unit this version writes${sizes.length ? ", sizes aside" : ""}`);
    }
    for (const line of compared.removed) say(`${RED}- ${line}${RESET}`);
    for (const line of compared.added) say(`${GREEN}+ ${line}${RESET}`);
    say();
    say(
      compared.privileged
        ? `${DIM}a privileged install rewrites it itself after its next confirmed update; re-run install.sh to do it now${RESET}`
        : `${DIM}re-run install.sh once to rewrite it. It leaves .nouride/ alone${RESET}`,
    );
    return;
  }

  if (action === "status") {
    /**
     * The daemon's supervisor, asked over the control API, because `nouride restart` goes through the
     * daemon and that is the process it has to come back. This used to report on *its own* process,
     * which from a shell is never supervised — so it said "none" beside a daemon systemd was running.
     * Only when the daemon cannot be reached does it fall back to this process, and it says so.
     */
    const daemon = await connect({ soft: true })
      .then((client) => client.softGet<StatusResponse>("/status"))
      .then((status) => status.supervisor ?? null)
      .catch(() => null);
    const info = daemon ?? detectSupervisor({ inContainer: await fileExists("/.dockerenv") });
    const evidence = "evidence" in info && info.evidence ? ` ${DIM}(${info.evidence})${RESET}` : "";
    // The answer under `--json` too: `service` never emitted, so a script read `data: null` beside a supervisor.
    emit({ supervisor: info.kind, restartsOnExit: info.restartsOnExit, evidence: "evidence" in info ? (info.evidence ?? null) : null, fromDaemon: daemon !== null });
    if (!daemon) say(`${DIM}the daemon did not answer, so this describes this shell's own process${RESET}`);
    say(`supervisor: ${BOLD}${info.kind}${RESET}${evidence}`);
    say(
      info.restartsOnExit
        ? `${GREEN}✓${RESET} the daemon is respawned when it exits, so \`nouride restart\` is safe`
        : `${YELLOW}!${RESET} nothing respawns it; \`nouride restart\` would stop it for good`,
    );
    const native = nativeSupervisorFor();
    if (info.kind === "none" && native) {
      say(`${DIM}install one with: nouride service install --user <user>${RESET}`);
    }
    return;
  }

  // procd has no marker a process could read; OpenWrt's init is the binary itself.
  const { platform } = runningPlatform();
  const kind = flagValue(args, "--kind") ?? nativeSupervisorFor(platform, { procd: await fileExists("/sbin/procd") });
  if (!kind) fail(`no supported service manager on ${platform}`, "pass --kind systemd, launchd or procd");
  // Named, not defaulted: anything that was not `systemd` used to be written as a launchd plist.
  if (kind !== "systemd" && kind !== "launchd" && kind !== "procd") usageError(`--kind ${kind}: expected systemd, launchd or procd`);

  const workingDir = flagValue(args, "--dir") ?? process.cwd();
  const user = flagValue(args, "--user") ?? process.env.USER ?? process.env.LOGNAME ?? "";
  const execStart =
    flagValue(args, "--exec") ?? defaultExecStart(process.execPath, process.argv[1]);

  if (action === "install") {
    if (!user) usageError("pass --user: the unit has to name an account to run as");

    // Typed, never inferred. Nothing about the edition, the hardware or the presence of an
    // appliance identity turns this on — an operator says it or it does not happen.
    const privileged = hasFlag(args, "--privileged");

    try {
      assertNotRoot(user, privileged);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }

    if (kind === "procd") {
      // procd runs it as root, as the privileged unit does — so it is asked for the same way, never assumed.
      if (!privileged) {
        fail("a procd service runs as root: pass --privileged, as for a machine dedicated to the agent");
      }
      const { procdInitScript, PROCD_FILE, PROCD_SCRIPT } = await import("@/service/procd.ts");
      const outPath = join(workingDir, PROCD_FILE);
      await writeTextFileAtomic(outPath, procdInitScript({ execStart, workingDir }));
      emit({ written: outPath, kind, user: "root", privileged: true });
      say(`${GREEN}✓${RESET} wrote ${BOLD}${outPath}${RESET}`);
      say();
      say("Review it, then install:");
      say(`  cp ${outPath} ${PROCD_SCRIPT} && chmod 0755 ${PROCD_SCRIPT}`);
      say(`  ${PROCD_SCRIPT} enable && ${PROCD_SCRIPT} restart`);
      say(`  logread -f -e nouride`);
      return;
    }

    const isSystemd = kind === "systemd";
    const envFile = join(workingDir, ".env");
    const params = {
      execStart,
      workingDir,
      user,
      ...(privileged ? { privileged } : {}),
      ...((await fileExists(envFile)) ? { envFile } : {}),
      // Root's file of the secret store's key, when install.sh made it (0.8.19): only systemd reads it, as root.
      ...(isSystemd && statFile(SYSTEM_KEY_FILE) ? { keyFile: SYSTEM_KEY_FILE } : {}),
      ...(isSystemd
        ? { memoryHighBytes: softMemoryCeiling(), tmpSizeBytes: tmpfsCeiling(), ...versionOf(await systemdVersion()) }
        : // A LaunchAgent runs as the account installing it (install.sh runs this as that account): its `~/.local/bin`
          // goes on the job's PATH (`launchdPath`), and the secret store's key is the file install.sh made in its
          // `~/.config/nouride/` (0.8.19), named by path: the plist never holds the key.
          { home: expandHome("~"), ...(statFile(expandHome(MAC_KEY_FILE)) ? { env: { NOURIDE_ENCRYPTION_KEY_FILE: expandHome(MAC_KEY_FILE) } } : {}) }),
    };

    // Written next to the data directory, not straight into a system path: the CLI may not be root,
    // and an operator should read a unit before installing it.
    const filename = isSystemd ? SYSTEMD_UNIT_NAME : `${LAUNCHD_LABEL}.plist`;
    const outPath = join(workingDir, filename);
    await writeTextFileAtomic(outPath, isSystemd ? systemdUnit(params) : launchdPlist(params));
    // Beside it, the helper that runs each agent's commands as its own user — for a daemon that is not root, which has
    // no other way to change user. Its folders from the config the daemon boots from, so boot finds them the same.
    const helper = isSystemd && !privileged ? await helperUnitsFor(user) : {};
    for (const [name, text] of Object.entries(helper)) await writeTextFileAtomic(join(workingDir, name), text);
    emit({ written: outPath, kind, user, privileged, ...(Object.keys(helper).length > 0 ? { helper: Object.keys(helper).map((name) => join(workingDir, name)) } : {}) });

    say(`${GREEN}✓${RESET} wrote ${BOLD}${outPath}${RESET}`);
    if (privileged) {
      // Said at the moment the unit is written, because after this it is a file somebody copies
      // without reading. The agent's real gate is its approval level over the fixed list, and this names it.
      say();
      say(`${YELLOW}!${RESET} privileged mode: no systemd sandbox, and ${BOLD}${user}${RESET} may be root`);
      say(`${DIM}  the agent can apt-install and manage services on this host.${RESET}`);
      say(`${DIM}  what still gates it: [security] approvals and the fixed list of what always asks.${RESET}`);
      say(`${DIM}  review with: nouride policy${RESET}`);
    }
    say();
    say("Review it, then install:");
    if (isSystemd) {
      say(`  sudo cp ${outPath} /etc/systemd/system/${SYSTEMD_UNIT_NAME}`);
      for (const name of Object.keys(helper)) say(`  sudo cp ${join(workingDir, name)} /etc/systemd/system/${name}`);
      say(`  sudo systemctl daemon-reload`);
      if (Object.keys(helper).length > 0) say(`  sudo systemctl enable --now nouride-run.socket   ${DIM}# install.sh puts the helper itself in place first${RESET}`);
      say(`  sudo systemctl enable --now nouride`);
      say(`  journalctl -u nouride -f`);
    } else {
      say(`  cp ${outPath} ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
      say(`  launchctl load -w ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
      // Must match `launchdPlist`'s StandardOutPath, or this prints a path nothing writes to.
      say(`  tail -f ${join(workingDir, ".nouride/data/nouride.log")}`);
    }
    say();
    if (!(await fileExists(envFile))) {
      // Said here because it is the moment it matters: a unit with no credentials starts and then
      // fails at the first turn, which looks like a bug in the daemon.
      say(`${YELLOW}!${RESET} no .env in ${workingDir}: the service will start with no provider keys`);
    }
    say(`${DIM}the unit runs as ${user}; make sure that account owns ${workingDir}${RESET}`);
    return;
  }

  if (action === "uninstall") {
    // Printed, not executed, for the same reason as install.
    emit({ kind });
    say("Remove it with:");
    if (kind === "procd") {
      say(`  /etc/init.d/nouride stop && /etc/init.d/nouride disable`);
      say(`  rm /etc/init.d/nouride`);
    } else if (kind === "systemd") {
      say(`  sudo systemctl disable --now nouride`);
      say(`  sudo rm /etc/systemd/system/${SYSTEMD_UNIT_NAME}`);
      say(`  sudo systemctl daemon-reload`);
    } else {
      say(`  launchctl unload -w ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
      say(`  rm ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    }
    return;
  }

  unknownAction("service", action);
}

/**
 * Four fifths of what this machine reports it has, in bytes.
 *
 * Read here rather than written as `MemoryHigh=80%` in the unit, and the difference is not cosmetic:
 * inside an LXC systemd resolves a percentage against the *host's* memory rather than the
 * container's. On a 2 GB container of a 62 GB Proxmox node, `80%` came out as 49.8 GB — forty times
 * above anything the container could reach, which is no ceiling at all. Measured on a live box.
 *
 * `totalMemoryBytes` reads the container's own figure (lxcfs makes `/proc/meminfo` tell the truth
 * inside one), so the number is right for the machine the unit is written on — and stale if that
 * machine is later resized, which re-running this fixes.
 */
function softMemoryCeiling(): number | undefined {
  const total = totalMemoryBytes();
  return total > 0 ? Math.floor(total * 0.8) : undefined;
}

/**
 * How big the service's private `/tmp` may get. See `SystemdUnitParams.tmpSizeBytes`.
 *
 * An eighth of the machine, floored at 64 MB and capped at 1 GB. The floor is there because a
 * `/tmp` too small to hold a lock file breaks ordinary tools; the cap because past a point this stops
 * being a scratch space and starts being somewhere work accumulates — and the agent already has a
 * scratchpad on disk for that, which `TMPDIR` already points every child process at.
 *
 * On the 2 GB container this was written for: 256 MB, against the 32 GB systemd was advertising.
 */
function tmpfsCeiling(): number | undefined {
  const total = totalMemoryBytes();
  if (total <= 0) return undefined;
  return Math.min(Math.max(Math.floor(total / 8), 64 * 1024 * 1024), 1024 * 1024 * 1024);
}
