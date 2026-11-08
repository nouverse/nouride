/**
 * Why `Environment=HOME` is in the hardening block below.
 *
 * `ProtectHome=read-only` means the service user's real home cannot be written, and every tool an
 * agent runs wants to write there. Found by reading job logs: `ssh` opened *every* background job
 * with "Failed to add the host to the list of known hosts (/home/nouride/.ssh/known_hosts)". Harmless
 * on its own — ssh proceeds — but host keys were never remembered, `accept-new` re-accepted on every
 * connection, and that line was the first thing in every failure report on the box. `git config`, the
 * Bun cache and npm's prefix were all failing the same way, silently.
 *
 * Pointing HOME at a writable directory fixes them and keeps the hardening — all but ssh, which reads the home
 * /etc/passwd gives and not HOME; the wrappers `boot/ssh-config.ts` writes cover it since 0.7.17: a daemon whose
 * whole purpose is running commands on this host is the last one that should be able to write to a
 * person's home directory.
 *
 * `.nouride/home` since 0.6, not the install directory itself: an agent's ssh keys and config, its
 * known hosts, a CLI it logged in to — all of it is state the agent built, and it belongs with the
 * rest of that state, so copying `.nouride/` moves an install whole. `install.sh` copies what the old
 * HOME held across on upgrade, and leaves the old copy where it was.
 */

import { guardScript } from "@/service/update-guard.ts";
/**
 * Service unit generation — `nouride service install`.
 *
 * The units are written here rather than shipped as static files because three of their values are
 * only knowable at install time: the absolute path of the binary, the working directory holding
 * `data/` and `agents/`, and the user to run as. A static unit with placeholders is a unit someone
 * edits wrongly at 1am.
 *
 * The hardening directives are the point of doing this at all. A daemon that runs arbitrary
 * commands on the operator's host should at least not be able to write to `/usr` while doing it —
 * and on a server this is the only layer between "the agent ran something odd" and "the machine
 * needs reinstalling".
 */

export interface UnitParams {
  /** Absolute path to the `nouride` binary or `bun` entrypoint. */
  execStart: string;
  /** Directory containing `data/` and `agents/`. */
  workingDir: string;
  /** POSIX user to run as. Never `root` unless `privileged` is set — see `assertNotRoot`. */
  user: string;
  /**
   * Privileged mode: this daemon owns the host it runs on.
   *
   * A posture, not a product tier — nothing here knows or cares which edition this is, and it is
   * deliberately unrelated to appliance pairing and licensing. What it describes is a machine with
   * one user, one purpose and no other workload, whose whole value is that the agent can operate
   * it: `apt install`, `systemctl`, reading logs that root owns. A Nouride Box is the obvious case;
   * a homelab VM somebody dedicated to this is the same case.
   *
   * Three directives in the standard hardening block make all of that impossible, and each of them
   * is right for an ordinary install:
   *
   *   `User=<unprivileged>`     an account with no sudoers entry
   *   `NoNewPrivileges=true`    `sudo` is setuid, so it cannot elevate even given sudoers
   *   `ProtectSystem=strict`    `/usr` and `/etc` are read-only, so `apt` fails as root too
   *
   * An agent that hits all three does not report "permission denied" and stop. It works around
   * them — installing into a home directory, vendoring a binary, answering a different question
   * from the one it was asked — which is worse than a refusal, because the operator never learns
   * that the box is the reason.
   *
   * So this mode drops them, and what stands in front of the model is the layer that was always
   * doing the real work: the approval level (`careful` approves each new command once, through the paired
   * chat) over the fixed list that can never become standing grants (`mkfs`, `dd`, `rm -rf /`, stopping
   * this daemon). Those are unchanged here, and they are what to tighten on a host like this, because they
   * refuse per command instead of refusing everything.
   *
   * **Never a default.** `nouride service install --privileged` sets it, and the Box image is built
   * with it. An install that does not ask for it keeps every directive above.
   */
  privileged?: boolean;
  /** Extra environment, e.g. `PORT`. Secrets belong in an env file, not here. */
  env?: Record<string, string>;
  /**
   * Soft memory ceiling for the whole slice, in bytes. Omitted leaves the machine unbounded.
   *
   * A number and **not** `80%`, which is what this was first written as. Inside an LXC systemd
   * resolves a percentage against the *host's* memory, not the container's: on a 2 GB container of a
   * 62 GB Proxmox box, `MemoryHigh=80%` came out as 49.8 GB — a ceiling forty times above anything
   * the container could reach, which is to say no ceiling at all. Measured, not guessed.
   *
   * Computed at install time from what this machine reports, so it is right for the machine it is
   * written on and stale if that machine is later resized. Re-running the installer fixes that.
   */
  memoryHighBytes?: number;
  /**
   * Size of the service's private `/tmp`, in bytes. Omitted falls back to `PrivateTmp=`, unbounded.
   *
   * `PrivateTmp=` mounts a tmpfs, and a tmpfs is RAM. systemd sizes it at half of what the kernel
   * reports, which inside an LXC is the **host's** memory: on a 2 GB container of a 62 GB Proxmox box
   * `df` advertised 32 GB of free space in `/tmp`. The same mistake `MemoryHigh=80%` made above, in a
   * place with no percentage to get wrong.
   *
   * An agent then ran `git clone` of a 1.2 GB repository into `/tmp` — nothing warned, because as far
   * as anything could see there was 32 GB free. The clone's pages are charged to the service's cgroup,
   * so it crossed `MemoryHigh`, and the kernel throttled the daemon until its gateways timed out. It
   * did not crash and systemd never restarted it; it simply stopped answering, which from a chat
   * window is indistinguishable from dead.
   *
   * Bounded, the same write fails with ENOSPC — a failure the agent can see, report and work around.
   * Measured at install time, like the ceiling above, and stale if the machine is later resized.
   */
  tmpSizeBytes?: number;
  /**
   * Path to a file of `KEY=value` lines holding credentials.
   *
   * Separate from `env` on purpose: unit files are world-readable by default and end up in
   * version control and pasted into issues. A provider key in `Environment=` is a leaked key.
   */
  envFile?: string;
  /**
   * Root's file of the secret store's key, `/etc/nouride/nouride.env` (0.8.19), made by `install.sh`. systemd reads an
   * `EnvironmentFile=` as root before it starts the service as `User=`, so the key reaches the daemon and its user never
   * reads the file. After `envFile`, so it wins over a key line the daemon left in the install's `.env`; `-` so a unit
   * whose file is gone still starts, and the daemon says what is missing.
   */
  keyFile?: string;
  /**
   * The systemd this unit is for, as `systemctl --version` says. A directive newer than it is left out, so the
   * unit keeps saying only what that systemd knows — one it does not is a warning in the journal and a setting that
   * looks made and is not. Unknown, every directive newer than the unit's floor (v238, `TemporaryFileSystem=`) is
   * left out.
   */
  systemdVersion?: number;
}

export const SYSTEMD_UNIT_NAME = "nouride.service";

/** The oldest systemd every directive below works on — `TemporaryFileSystem=` came in v238. */
const UNIT_FLOOR = 238;

/** `directive` when this systemd is at least `since`. */
const since = (version: number | undefined, at: number, directive: string): string =>
  (version ?? UNIT_FLOOR) >= at ? `${directive}\n` : "";

/** The service's HOME: inside `.nouride/`, beside everything else the agents keep. See the note at the top. */
function agentHome(workingDir: string): string {
  return `${workingDir.replace(/\/+$/, "")}/.nouride/home`;
}
export const LAUNCHD_LABEL = "tech.nouverse.nouride";

/** Where launchd writes the daemon's output, from its working directory — the daemon keeps it to one size (`startLogFileRotation`). */
export const LAUNCHD_LOG_FILE = ".nouride/data/nouride.log";

/**
 * The hardening an ordinary install gets.
 *
 * The daemon runs commands on this host by design, which is exactly why the blast radius of the
 * *daemon itself* should be bounded. On a server it also runs other people's work, and this is the
 * only layer between "the agent ran something odd" and "the machine needs reinstalling".
 */
function standardHardening(privateTmp: string, workingDir: string, systemdVersion: number | undefined): string {
  return `
# Hardening. The daemon runs commands on this host by design, which is exactly why the blast
# radius of the *daemon itself* should be bounded.
NoNewPrivileges=true
${privateTmp}ProtectSystem=strict
ProtectHome=read-only
# The one path it must write: data/ and agents/ live here.
ReadWritePaths=${workingDir}

# ProtectHome above makes the real home read-only, so HOME points at the writable directory
# instead: ssh known_hosts, git config and tool caches all live under it.
Environment=HOME=${agentHome(workingDir)}
ProtectKernelTunables=true
ProtectKernelModules=true
${controlGroups(systemdVersion)}RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
# No capabilities, so none can be gained by any path NoNewPrivileges does not already close. An
# unprivileged account holds none to lose.
CapabilityBoundingSet=
# Sockets of the families the daemon and what agents run use: Unix (D-Bus, nouride-pkg, ssh-agent), IPv4
# and IPv6, and netlink, which address lookup and \`ip\` read through. Raw packet sockets need a
# capability this account never has, so nothing that worked is closed.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
# A realtime busy loop holds a core however hard everything else asks for it.
RestrictRealtime=true
`;
}

/**
 * What the unit may do to the cgroup filesystem: write its own cgroup, which it splits (`Delegate=yes`), and nothing
 * else. `ProtectControlGroups=true` made all of it read-only, the daemon's own cgroup too. systemd 257 gives a unit
 * a view of its own (`private`); before it the line goes, and the account's permissions are what stand there — an
 * unprivileged user with no capabilities can write no cgroup it was not handed.
 */
function controlGroups(version: number | undefined): string {
  return since(version, 257, "# Its own view of the cgroup filesystem, writable where its cgroup is (Delegate= hands it over).\nProtectControlGroups=private") ||
    "# No ProtectControlGroups: on this systemd it would make the daemon's own cgroup read-only, which it splits\n# (Delegate=). An account with no capabilities can write no other.\n";
}

/**
 * The hardening a host the daemon owns gets, which is none of it.
 *
 * Every directive above exists to bound what the daemon can do to a host it *shares*. This kind of
 * host shares nothing: one user, one purpose, no other workload, and a machine whose entire value
 * is that the agent can operate it. Keeping them would not make it safer, it would make it lie —
 * see the note on `UnitParams.privileged` for what an agent does when it meets a wall it cannot
 * report.
 *
 * `RestrictNamespaces` and `ProtectControlGroups` go too, and they are the reason this is a list
 * rather than three lines: without them Docker, Podman and LXC do not run, and "install a container
 * and point the agent at it" is the first thing anybody does with a machine like this.
 *
 * `/tmp` keeps its ceiling, because that is sizing, not hardening. The Box's own `/tmp` is a tmpfs of half
 * its RAM, every page the agent writes there is charged to this unit, and `MemoryHigh` then throttles the daemon
 * with it until it stops answering — the failure `tmpSizeBytes` describes, on the machine with the least memory to
 * spare. So `/tmp` is a private tmpfs of the measured size, as on any install, and `/var/tmp` stays the host's: on
 * disk, where a file meant for another service — a container's bind mount — is the one that service sees.
 */
function privilegedHardening(workingDir: string, tmpSizeBytes: number | undefined): string {
  const tmp = tmpSizeBytes
    ? `
# /tmp is private and bounded, because the host's is RAM charged to this unit; /var/tmp is the
# host's own, on disk, for a file another service has to see.
TemporaryFileSystem=/tmp:size=${tmpSizeBytes},mode=1777
`
    : "";
  return `
# PRIVILEGED MODE: this daemon owns the host it runs on.
#
# No NoNewPrivileges, no ProtectSystem, no namespace restrictions: the agent is meant to run
# \`apt install\`, manage services and use containers on this machine. What gates it is the approval
# level in config.toml: \`[security] approvals = "careful"\` approves each new command once through the
# paired chat, and the fixed list (mkfs, dd, rm -rf /, stopping this daemon) asks every time and can
# never become a standing grant. Tighten THAT here; it refuses per command instead of refusing everything.
#
# Written by \`nouride service install --privileged\`. An ordinary install gets the hardened unit.
Environment=HOME=${agentHome(workingDir)}
${tmp}`;
}

/**
 * Bun's virtual filesystem root inside a `--compile` binary.
 *
 * The compiled entrypoint is reported as `/$bunfs/root/nouride`, a path that exists only to Bun's own
 * module resolver.
 */
const BUNFS_PREFIX = "/$bunfs/";

/**
 * The command a service manager should run to start the daemon.
 *
 * Two shapes, because the daemon is launched two ways. From a checkout it is `bun <script> start`; a
 * compiled binary is itself the command and takes no script, so passing one hands systemd an argument
 * it cannot resolve. The unit was coming out as
 * `ExecStart=/srv/nouride/nouride /$bunfs/root/nouride start`.
 *
 * The bunfs path is detected by prefix rather than by asking whether it exists, because it *does*:
 * `Bun.file().exists()` and `fs.existsSync()` both answer true for a path inside the virtual
 * filesystem, so an existence check sees no difference between the two shapes.
 */
export function defaultExecStart(execPath: string, entryScript: string | undefined): string {
  const script = entryScript ?? "";
  if (!script || script.startsWith(BUNFS_PREFIX)) return `${execPath} start`;
  return `${execPath} ${script} start`;
}

export function systemdUnit(params: UnitParams): string {
  const environment = Object.entries(params.env ?? {})
    .map(([key, value]) => `Environment=${key}=${value}`)
    .join("\n");

  /**
   * A private `/tmp` and `/var/tmp`, with a ceiling where one could be measured.
   *
   * `TemporaryFileSystem=` rather than `PrivateTmp=` because only the former takes a size, and the
   * isolation is the same: a fresh tmpfs mounted over each path, invisible to and from the host.
   * `mode=1777` is what `/tmp` is, and leaving it off gives a directory nothing unprivileged can
   * write to.
   *
   * `/var/tmp` is deliberately much smaller. It is meant for files that outlive a reboot, which is
   * exactly what a tmpfs is not, so anything reaching for it here is already in the wrong place.
   *
   * Falls back to plain `PrivateTmp=` where the size is unknown — an unbounded private /tmp is what
   * this has always shipped, and a unit that refuses to describe itself is worse than one that keeps
   * the old behaviour.
   */
  const privateTmp = params.tmpSizeBytes
    ? `# Private, and bounded: a tmpfs is RAM, and systemd sizes it from the host's memory, not this
` +
      `# machine's. A 1.2 GB clone into /tmp is what this number stands in front of.
` +
      `TemporaryFileSystem=/tmp:size=${params.tmpSizeBytes},mode=1777
` +
      `TemporaryFileSystem=/var/tmp:size=${Math.floor(params.tmpSizeBytes / 4)},mode=1777
`
    : "PrivateTmp=true\n";

  /**
   * Everything this slice does — the daemon and every command it spawns — gets reclaim pressure past
   * four fifths of the machine, instead of the container running out and something dying.
   *
   * A *soft* limit on purpose. MemoryMax kills, and the process it kills is whichever one asks for
   * the next page: as likely the daemon holding nine gateway connections as the build that caused
   * it. MemoryHigh throttles instead, so a runaway build gets slow and the box stays answerable.
   *
   * Written after a 2-core/2 GB container was taken down by twelve concurrent typecheck processes an
   * agent started. The tooling that caused that is bounded now too, but the next runaway will not be
   * ours and this is what stands in front of it.
   *
   * Needs cgroup v2, which every systemd since v230 defaults to. Where it is unavailable systemd
   * ignores the line rather than refusing to start.
   */
  const memoryHigh = params.memoryHighBytes
    ? `# Soft ceiling for the daemon and everything it spawns: throttle, never kill.\nMemoryHigh=${params.memoryHighBytes}\n`
    : "";

  /**
   * When the kernel kills one process of the unit for memory, that process is what goes.
   *
   * systemd's default, `OOMPolicy=stop`, stops the whole unit when any of its processes is OOM-killed — so a build an
   * agent ran, killed for eating the machine, took the daemon, every gateway and every turn down with it, and
   * `Restart=always` brought back a daemon that had lost them all. The commands an agent runs are what the kernel
   * reaches for first (`withOomPreference` in the runtime), and with this the daemon survives them. v243 and later;
   * before it there was no policy, and no stop.
   */
  const oom = since(params.systemdVersion, 243, "# A command the kernel kills for memory is killed alone: the daemon and its turns stay up.\nOOMPolicy=continue");

  /**
   * The unit's cgroup is the daemon's to split (0.7.19). It moves itself into `daemon/`, protected, and runs every
   * command an agent starts in `commands/`, capped below `MemoryHigh` (`process-cgroup.ts` in the runtime): a build
   * that eats the machine used to hold the whole unit over its ceiling, and the kernel throttled the daemon with it
   * until nothing answered. `NOURIDE_CGROUP` is how the daemon knows it was handed the cgroup — not merely able to
   * write it, as root always is.
   */
  const delegate =
    "# The daemon splits its cgroup in two: itself, protected, and what agents run, capped below MemoryHigh. So a\n" +
    "# command that eats the machine is what the kernel stops, and the daemon keeps answering.\nDelegate=yes\nEnvironment=NOURIDE_CGROUP=delegated\n";

  return `[Unit]
Description=Nouride multi-agent runtime
Documentation=https://github.com/nouverse/nouride
# Chat gateways and LLM endpoints are all remote, so starting before the network is up just
# produces a reconnect storm in the log.
After=network-online.target
Wants=network-online.target
# Give up after five failures in two minutes, and stay failed.
#
# Without a limit, Restart=always retries for ever, and a config the daemon refuses becomes a silent
# loop: systemctl status reports "activating" on every check, which reads as "still starting" rather
# than "has given up". Measured on a live box: 29 restarts in two and a half minutes, and the first
# clue anyone had was the chat going quiet.
#
# Stopping makes the state honest: "failed", with the reason in the journal, and systemctl reset-failed
# to try again once the config is fixed.
#
# In [Unit], not [Service]. systemd moved these in v230; left in [Service] they are ignored, so the
# limit would look configured and do nothing, the exact silent no-op this repo keeps finding.
StartLimitBurst=5
StartLimitIntervalSec=120

[Service]
Type=simple
User=${params.user}
WorkingDirectory=${params.workingDir}
# Nothing it creates is readable by other users unless it says so: the systemd default, 0022, made
# every file world-readable for the moment before a chmod: a log, a job's output, a snapshot.
UMask=0027
# While an update is unconfirmed, count the starts and, on the fourth, put the previous version back
# (modules/update/confirm.ts). Outside the binary on purpose: a new binary that crashes at once cannot
# rescue itself. Does nothing when no update is pending, and "-" so a failure here never blocks a start.
ExecStartPre=-/bin/sh -c '${guardScript(params.workingDir).replace(/\$/g, "$$$$")}'
ExecStart=${params.execStart}
${environment}${environment ? "\n" : ""}${params.envFile ? `EnvironmentFile=${params.envFile}\n` : ""}${params.keyFile ? `EnvironmentFile=-${params.keyFile}\n` : ""}\
# Ours, so detectSupervisor recognises a unit we generated even where INVOCATION_ID is absent.
Environment=NOURIDE_SERVICE_KIND=systemd

Restart=always
RestartSec=5
# Give the shutdown sequence room: in-flight turns are saved on SIGTERM, and killing it early
# loses conversation context. Matches [daemon] shutdown_timeout_ms with headroom.
TimeoutStopSec=45
KillSignal=SIGTERM
# The signal goes to the daemon alone; whatever is left when it exits is SIGKILLed. The default sends
# SIGTERM to every process in the unit at once, so the command a turn was running died at the start of
# the shutdown instead of finishing its step, and MCP servers went before the turns still calling them.
# The daemon stops its own children, in order (boot/shutdown.ts).
KillMode=mixed

${memoryHigh}${oom}${delegate}\
${params.privileged ? privilegedHardening(params.workingDir, params.tmpSizeBytes) : standardHardening(privateTmp, params.workingDir, params.systemdVersion)}
# Journal, not a file: rotation and retention are then the system's problem rather than ours.
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nouride

[Install]
WantedBy=multi-user.target
`;
}

/**
 * The `PATH` a LaunchAgent gets: Homebrew's and the account's own bin directories first, then the system's.
 *
 * launchd gives a job `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else, and a `PATH=` in `.env` cannot help, because a
 * variable the process already has wins over the file. So Homebrew (`/opt/homebrew/bin` on Apple Silicon,
 * `/usr/local/bin` before it) and `~/.local/bin` were invisible to the daemon and to every command an agent ran:
 * ffmpeg, brew, a CLI somebody installed for it (finding 8 of issue #7 on nouride-releases). `home` is the account the
 * agent runs as; without one, `~/.local/bin` is left out rather than guessed.
 */
function launchdPath(home?: string): string {
  const own = home ? [`${home.replace(/\/+$/, "")}/.local/bin`] : [];
  return ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", ...own, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

export function launchdPlist(params: UnitParams & { home?: string }): string {
  // `PATH` before the operator's own env, so a PATH given there still wins.
  const env = { NOURIDE_SERVICE_KIND: "launchd", PATH: launchdPath(params.home), ...params.env };
  const entries = Object.entries(env)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");

  // `ProgramArguments` takes an argv array, so the path is not re-parsed by a shell and a space in
  // it cannot split the command. launchd has no `ExecStartPre`, so the update guard runs first in a `sh` that then
  // execs that argv as it stands (`$0 "$@"`): without it an update that never came up on a Mac was started again
  // every ten seconds, and nothing put the previous version back. A subshell, because the guard ends with `exit`.
  const argv = ["/bin/sh", "-c", `(${guardScript(params.workingDir)}); exec "$0" "$@"`, ...params.execStart.split(" ").filter(Boolean)]
    .map((part) => `    <string>${escapeXml(part)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(params.workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- Without this, a daemon that fails at startup is respawned in a tight loop. -->
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>45</integer>
  <!-- 0027, as the systemd unit's UMask=0027: what the daemon and its commands create is not readable by
       every account on the Mac. Decimal, as a plist integer is. -->
  <key>Umask</key>
  <integer>23</integer>
  <!-- launchd has no journal, so the daemon's stdout has to go to a file, and launchd creates the
       file but never the directory above it: a path whose parent is missing loses the log silently
       and the operator tails something that never appears. .nouride/data is the default of data_dir;
       install.sh creates it before the job is loaded, so the first boot's log - with the one-time admin
       password - is there too. An install that moved data_dir should point these two keys at the new location. -->
  <key>StandardOutPath</key>
  <string>${escapeXml(params.workingDir)}/${LAUNCHD_LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(params.workingDir)}/${LAUNCHD_LOG_FILE}</string>
</dict>
</plist>
`;
}

/**
 * Refuse to generate a unit that runs as root, unless the operator asked for exactly that.
 *
 * This daemon executes commands chosen by a language model, reachable from a chat app. Running that
 * as root removes every remaining boundary — the exec allowlist, the workspace sandbox and the file
 * modes all assume an unprivileged user. `sudo` is on the hardline list precisely so that
 * escalation is a decision a human makes per command; installing as root makes it the default.
 *
 * That reasoning holds for a daemon installed onto a machine that has other work to do. It does not
 * hold for a machine dedicated to being operated by that agent, where the same refusal produces an
 * agent that quietly works around the host it was bought to run. So the escape hatch is a flag an
 * operator types — `--privileged`, never a default and never inferred from anything else about the
 * install.
 */
export function assertNotRoot(user: string, privileged = false): void {
  if (privileged) return;

  if (user === "root" || user === "0") {
    throw new Error(
      "refusing to generate a unit that runs as root: this daemon runs model-chosen commands, " +
        "and every other boundary in it (exec policy, workspace sandbox, 0600 file modes) assumes " +
        "an unprivileged user. Create a user for it and pass --user.",
    );
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
