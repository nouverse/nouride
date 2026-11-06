/**
 * Supervisor detection and unit generation.
 *
 * Detection decides what `nouride restart` *means* — exit and be respawned, or exit and be gone — so
 * a wrong answer here is a daemon that vanishes when the operator asked it to restart.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSupervisor, nativeSupervisorFor } from "@/service/supervisor.ts";
import { parseSystemdVersion } from "@/service/drift.ts";
import { markPendingUpdate } from "@/modules/update/confirm.ts";
import { GUARD_STARTS } from "@/service/update-guard.ts";
import {
  assertNotRoot,
  defaultExecStart,
  launchdPlist,
  systemdUnit,
} from "@/service/unit.ts";

describe("detectSupervisor", () => {
  test("no markers means nothing will bring it back", () => {
    const info = detectSupervisor({ env: {} });
    expect(info.kind).toBe("none");
    expect(info.restartsOnExit).toBe(false);
  });

  const SYSTEMD_CASES: string[][] = [["INVOCATION_ID"], ["JOURNAL_STREAM"], ["SYSTEMD_EXEC_PID"]];
  test.each(SYSTEMD_CASES)(
    "systemd is detected from %s",
    (marker) => {
      const info = detectSupervisor({ env: { [marker]: "abc" } });
      expect(info.kind).toBe("systemd");
      expect(info.restartsOnExit).toBe(true);
      expect(info.evidence).toBe(marker);
    },
  );

  const LAUNCHD_CASES: string[][] = [["XPC_SERVICE_NAME"], ["LAUNCH_JOB_LABEL"], ["LAUNCH_JOB_NAME"]];
  test.each(LAUNCHD_CASES)(
    "launchd is detected when %s names our job",
    (marker) => {
      expect(detectSupervisor({ env: { [marker]: "tech.nouverse.nouride" } }).kind).toBe("launchd");
    },
  );

  test("XPC_SERVICE_NAME=0 is an ordinary macOS shell, not a launchd job", () => {
    // Found live, and it was the worst possible failure: presence-only detection made a
    // hand-started daemon report `launchd`, so `nouride restart` answered "launchd will restart it",
    // exited — and nothing did. Verified after the fact: health 000, zero processes.
    //
    // macOS exports XPC_SERVICE_NAME into every process from a GUI session.
    expect(detectSupervisor({ env: { XPC_SERVICE_NAME: "0" } }).kind).toBe("none");
    expect(detectSupervisor({ env: { XPC_SERVICE_NAME: "0" } }).restartsOnExit).toBe(false);
  });

  test("someone else's launchd job is not ours", () => {
    // A different agent under the same launchd tells us nothing about whether *we* get respawned.
    expect(detectSupervisor({ env: { XPC_SERVICE_NAME: "com.apple.something" } }).kind).toBe("none");
    expect(detectSupervisor({ env: { LAUNCH_JOB_LABEL: "com.other.app" } }).kind).toBe("none");
  });

  test("an empty marker is not a marker", () => {
    // Exported-but-empty is common in shells and CI. Treating it as present would report a
    // supervisor that is not there, and `nouride restart` would exit expecting a respawn.
    expect(detectSupervisor({ env: { INVOCATION_ID: "" } }).kind).toBe("none");
    expect(detectSupervisor({ env: { INVOCATION_ID: "   " } }).kind).toBe("none");
  });

  test("our own marker wins over an inferred one", () => {
    // The only way to tell a unit we generated from an unrelated one that happens to run the same
    // binary under the same systemd.
    const info = detectSupervisor({ env: { NOURIDE_SERVICE_KIND: "launchd", INVOCATION_ID: "x" } });
    expect(info.kind).toBe("launchd");
    expect(info.evidence).toBe("NOURIDE_SERVICE_KIND");
  });

  test("a garbage NOURIDE_SERVICE_KIND falls through to detection", () => {
    expect(detectSupervisor({ env: { NOURIDE_SERVICE_KIND: "nonsense", INVOCATION_ID: "x" } }).kind)
      .toBe("systemd");
  });

  test("docker is detected but does not promise a restart", () => {
    // The restart policy lives outside the container. Claiming otherwise would make `nouride
    // restart` a coin flip: under `--restart=no` the daemon simply disappears.
    const info = detectSupervisor({ env: {}, inContainer: true });
    expect(info.kind).toBe("docker");
    expect(info.restartsOnExit).toBe(false);
  });

  test("docker under our entrypoint does promise a restart", () => {
    // The image's entrypoint respawns the daemon itself, so `nouride restart` works in a container
    // started with no restart policy at all — Dokploy, a bare `docker run`.
    const info = detectSupervisor({ env: { NOURIDE_CONTAINER_SUPERVISOR: "entrypoint" }, inContainer: true });
    expect(info.kind).toBe("docker");
    expect(info.restartsOnExit).toBe(true);
    // The marker means nothing outside a container.
    expect(detectSupervisor({ env: { NOURIDE_CONTAINER_SUPERVISOR: "entrypoint" } }).kind).toBe("none");
  });

  test("a real supervisor marker beats the container check", () => {
    // systemd-nspawn and podman-as-a-unit are both containers *and* supervised.
    expect(detectSupervisor({ env: { INVOCATION_ID: "x" }, inContainer: true }).kind).toBe("systemd");
  });

  test("an explicitly declared external supervisor is trusted", () => {
    const info = detectSupervisor({ env: { NOURIDE_SUPERVISOR_MODE: "s6" } });
    expect(info.kind).toBe("external");
    expect(info.restartsOnExit).toBe(true);
  });
});

describe("defaultExecStart", () => {
  /**
   * The unit generated by a compiled binary was unrunnable, and it was the *documented* install path:
   * DEPLOY.md says build the binary, `install` it to `/usr/local/bin`, then `nouride service install`.
   *
   *   ExecStart=/srv/nouride/nouride /$bunfs/root/nouride start
   *
   * `/$bunfs/` is Bun's virtual filesystem inside a `--compile` executable. Nothing outside that
   * process can resolve the path, so systemd started the daemon with a garbage first argument.
   */
  test("a compiled binary is the whole command", () => {
    expect(defaultExecStart("/usr/local/bin/nouride", "/$bunfs/root/nouride")).toBe(
      "/usr/local/bin/nouride start",
    );
  });

  test("a checkout keeps the script argument", () => {
    // `bun /srv/nouride/apps/engine/src/cli/main.ts start` — here argv[1] is a real file and dropping
    // it would leave `bun start`, which runs whatever `start` script the cwd's package.json has.
    expect(defaultExecStart("/usr/bin/bun", "/srv/nouride/apps/engine/src/cli/main.ts")).toBe(
      "/usr/bin/bun /srv/nouride/apps/engine/src/cli/main.ts start",
    );
  });

  test("a missing entry script does not become an empty argument", () => {
    // Was `${execPath} ${argv[1] ?? ""} start` — an absent argv[1] produced a double space and a
    // unit that systemd parses as an empty argument.
    expect(defaultExecStart("/usr/local/bin/nouride", undefined)).toBe("/usr/local/bin/nouride start");
    expect(defaultExecStart("/usr/local/bin/nouride", "")).toBe("/usr/local/bin/nouride start");
  });
});

describe("nativeSupervisorFor", () => {
  const NATIVE_CASES: [string, "systemd" | "launchd"][] = [
    ["linux", "systemd"],
    ["darwin", "launchd"],
  ];
  test.each(NATIVE_CASES)("%s → %s", (platform, expected) => {
    expect(nativeSupervisorFor(platform)).toBe(expected);
  });

  test("an unsupported platform is null, not a guess", () => {
    expect(nativeSupervisorFor("win32")).toBeNull();
  });
});

describe("systemdUnit", () => {
  const params = {
    execStart: "/usr/local/bin/nouride start",
    workingDir: "/srv/nouride",
    user: "nouride",
    env: { PORT: "18254" },
    envFile: "/srv/nouride/.env",
  };

  test("runs as the given user in the given directory", () => {
    const unit = systemdUnit(params);
    expect(unit).toContain("User=nouride");
    expect(unit).toContain("WorkingDirectory=/srv/nouride");
    expect(unit).toContain("ExecStart=/usr/local/bin/nouride start");
  });

  test("creates nothing other users can read — systemd's default umask made files world-readable until chmodded", () => {
    expect(systemdUnit(params)).toContain("\nUMask=0027\n");
  });

  test("carries the marker that makes the unit recognisable to itself", () => {
    expect(systemdUnit(params)).toContain("Environment=NOURIDE_SERVICE_KIND=systemd");
  });

  test("credentials come from an env file, never from Environment=", () => {
    // Unit files are world-readable, get committed, and get pasted into issues. A provider key in
    // `Environment=` is a leaked key.
    const unit = systemdUnit(params);
    expect(unit).toContain("EnvironmentFile=/srv/nouride/.env");
    expect(unit).toContain("Environment=PORT=18254");
  });

  test("restarts on failure with a delay", () => {
    const unit = systemdUnit(params);
    expect(unit).toContain("Restart=always");
    expect(unit).toMatch(/RestartSec=\d+/);
  });

  test("allows the shutdown sequence to finish", () => {
    // In-flight turns are persisted on SIGTERM. A stop timeout shorter than the daemon's own
    // shutdown budget loses conversation context on every restart.
    const unit = systemdUnit(params);
    expect(unit).toContain("KillSignal=SIGTERM");
    const stopSec = Number(/TimeoutStopSec=(\d+)/.exec(unit)?.[1]);
    expect(stopSec).toBeGreaterThan(30);
  });

  test("signals the daemon alone, so the command a turn is running can finish its step", () => {
    // Under the default control-group mode systemd SIGTERMs every child at once: measured on a live box,
    // a restart turned `sleep 8; echo step-one` into exit 143 while the turn was waiting for it.
    expect(systemdUnit(params)).toMatch(/^KillMode=mixed$/m);
  });

  test("hardens the daemon against itself, and still lets it write its own data", () => {
    const unit = systemdUnit(params);
    for (const directive of [
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "ProtectHome=read-only",
      "RestrictSUIDSGID=true",
    ]) {
      expect(unit).toContain(directive);
    }
    // /tmp is private either way — see the tmpfs tests below for which spelling and why.
    expect(unit).toMatch(/PrivateTmp=true|TemporaryFileSystem=\/tmp:/);
    // ProtectSystem=strict makes everything read-only, so without this the daemon cannot write
    // its own database and dies at boot — the hardening has to come with the exception.
    expect(unit).toContain("ReadWritePaths=/srv/nouride");
  });

  test("starts after the network is actually up", () => {
    // Chat gateways and LLM endpoints are all remote; starting earlier just produces a reconnect
    // storm in the journal.
    const unit = systemdUnit(params);
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("Wants=network-online.target");
  });

  test("omits the env file line entirely when there is none", () => {
    const unit = systemdUnit({ execStart: "/x", workingDir: "/y", user: "z" });
    expect(unit).not.toContain("EnvironmentFile=");
  });
});

describe("launchdPlist", () => {
  const params = { execStart: "/usr/local/bin/nouride start", workingDir: "/Users/g/nouride", user: "g" };

  test("passes argv as an array so a space cannot split the command", () => {
    const plist = launchdPlist(params);
    expect(plist).toContain("<string>/usr/local/bin/nouride</string>");
    expect(plist).toContain("<string>start</string>");
  });

  test("keeps the job alive and throttles a crash loop", () => {
    const plist = launchdPlist(params);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
  });

  test("escapes XML so a path with an ampersand cannot break the plist", () => {
    // An unescaped `&` makes the file unparseable, and launchd's error for that is unhelpful.
    const plist = launchdPlist({ ...params, workingDir: "/Users/a&b/nouride" });
    expect(plist).toContain("/Users/a&amp;b/nouride");
    expect(plist).not.toContain("/Users/a&b/nouride");
  });

  test("carries the service marker", () => {
    expect(launchdPlist(params)).toContain("NOURIDE_SERVICE_KIND");
  });

  /** The value of `key` in the plist's EnvironmentVariables, or null. */
  const envValue = (plist: string, key: string) => new RegExp(`<key>${key}</key>\\n\\s*<string>([^<]*)</string>`).exec(plist)?.[1] ?? null;

  test("gives the job a PATH with Homebrew and the account's ~/.local/bin ahead of the system's", () => {
    // launchd's own is /usr/bin:/bin:/usr/sbin:/sbin, and a PATH in .env cannot replace one the process already has:
    // ffmpeg, brew and whatever was installed into ~/.local/bin were invisible to the daemon and every agent command.
    const path = envValue(launchdPlist({ ...params, home: "/Users/g" }), "PATH")?.split(":") ?? [];
    expect(path.slice(0, 4)).toEqual(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/Users/g/.local/bin"]);
    expect(path.slice(4)).toEqual(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
    // No home, no guessed one.
    expect(envValue(launchdPlist(params), "PATH")).not.toContain(".local/bin");
  });

  test("a PATH the operator passes in env is the one the job gets", () => {
    expect(envValue(launchdPlist({ ...params, home: "/Users/g", env: { PATH: "/custom/bin:/usr/bin" } }), "PATH")).toBe("/custom/bin:/usr/bin");
  });

  test("sets the umask the systemd unit has, 0027", () => {
    const plist = launchdPlist(params);
    expect(plist).toMatch(/<key>Umask<\/key>\n\s*<integer>23<\/integer>/);
    expect(23).toBe(0o027);
    expect(systemdUnit({ ...params, user: "nouride" })).toContain("UMask=0027");
  });

  // `plutil` on a Mac; elsewhere the text checks above are what there is.
  test.skipIf(process.platform !== "darwin")("is a plist macOS itself accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-plist-"));
    try {
      const file = join(dir, "tech.nouverse.nouride.plist");
      writeFileSync(file, launchdPlist({ ...params, home: "/Users/g" }));
      const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
      expect(lint.stdout).toContain("OK");
      const json = JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }).stdout);
      expect(json.Umask).toBe(23);
      expect(json.EnvironmentVariables.PATH.startsWith("/opt/homebrew/bin:")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** The plist's ProgramArguments, unescaped: what launchd runs on every start. */
  const programArguments = (plist: string) =>
    [.../<key>ProgramArguments<\/key>\n\s*<array>\n([\s\S]*?)\n\s*<\/array>/.exec(plist)![1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
      m[1]!.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
    );

  test("runs the update guard before every start, then the command as it stands", () => {
    // launchd has no ExecStartPre: without the guard in the job itself, an update that never came up on a Mac was
    // started again every ten seconds and the previous version never came back.
    const dir = mkdtempSync(join(tmpdir(), "nouride-launchd-guard-"));
    try {
      const program = (name: string) => `#!/bin/sh\necho "${name} $*"\n`;
      writeFileSync(join(dir, "nouride"), program("NEW"));
      mkdirSync(join(dir, ".nouride-previous"));
      writeFileSync(join(dir, ".nouride-previous", "nouride"), program("OLD"));
      chmodSync(join(dir, "nouride"), 0o755);
      chmodSync(join(dir, ".nouride-previous", "nouride"), 0o755);
      const [cmd, ...args] = programArguments(launchdPlist({ ...params, workingDir: dir, execStart: `${dir}/nouride start --port 18254` }));
      const start = () => spawnSync(cmd!, args, { encoding: "utf8" }).stdout.trim();

      expect(start()).toBe("NEW start --port 18254");
      markPendingUpdate(dir, { from: "0.8.2", to: "v0.8.3" });
      for (let i = 0; i < GUARD_STARTS; i++) expect(start()).toBe("NEW start --port 18254");
      expect(start()).toBe("OLD start --port 18254");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("logs into the data directory the daemon actually creates", () => {
    // launchd has no journal, so stdout goes to a file — and launchd creates the file but never the
    // directory above it. It used to point at `<dir>/data/`, which no install has: `data_dir`
    // defaults to `./.nouride/data`. The log silently went nowhere and `nouride service install`
    // printed a `tail -f` for a path that never appeared.
    const plist = launchdPlist(params);
    expect(plist).toContain("<string>/Users/g/nouride/.nouride/data/nouride.log</string>");
    expect(plist).not.toContain("<string>/Users/g/nouride/data/nouride.log</string>");
  });
});

describe("assertNotRoot", () => {
  test.each([["root"], ["0"]])("refuses %s", (user) => {
    // The daemon runs model-chosen commands reachable from a chat app. Every other boundary in it
    // — exec policy, workspace sandbox, 0600 file modes — assumes an unprivileged user.
    expect(() => assertNotRoot(user)).toThrow(/refusing/);
  });

  test("permits an ordinary user", () => {
    expect(() => assertNotRoot("nouride")).not.toThrow();
  });

  test("privileged mode permits root, because the host IS the thing being operated", () => {
    expect(() => assertNotRoot("root", true)).not.toThrow();
  });
});

/**
 * Privileged mode — a host posture, deliberately unrelated to appliance pairing and licensing.
 *
 * The rule under test is a pair, and only the pair is worth anything: the privileged unit must drop
 * the sandbox, and the ordinary unit must not. A change that relaxed both would pass any test that
 * looked at only one of them, and it would ship a hardened server install that is no longer
 * hardened.
 */
describe("privileged units", () => {
  const box = {
    execStart: "/srv/nouride/nouride start",
    workingDir: "/srv/nouride",
    user: "root",
    privileged: true,
  };

  test("drops the three directives that make `apt install` impossible", () => {
    const unit = systemdUnit(box);
    // NoNewPrivileges blocks setuid, so sudo cannot elevate; ProtectSystem makes /usr and /etc
    // read-only, so apt fails even as root. Both have to go, not one.
    expect(unit).not.toContain("NoNewPrivileges=true");
    expect(unit).not.toContain("ProtectSystem=strict");
    expect(unit).not.toContain("ProtectHome=read-only");
  });

  test("drops the namespace restrictions, so containers run on a box", () => {
    // "Install Docker and point the agent at it" is the first thing anybody does with a box like
    // this, and RestrictNamespaces alone is enough to make it fail in a way nothing explains.
    const unit = systemdUnit(box);
    expect(unit).not.toContain("RestrictNamespaces=true");
    expect(unit).not.toContain("ProtectControlGroups=true");
  });

  test("still gives the daemon a writable HOME, inside .nouride/ with everything else the agents keep", () => {
    // Not hardening — ssh known_hosts, git config and tool caches all live under HOME, and without
    // this every one of them fails quietly. Under .nouride/ so copying it moves an install whole.
    expect(systemdUnit(box)).toContain("Environment=HOME=/srv/nouride/.nouride/home");
  });

  test("names the gate that replaced the sandbox, in the file an operator reads", () => {
    // The unit is copied by somebody who may never read this repository. It has to say what still
    // stands in front of the model, or appliance mode reads as "nothing gates it".
    expect(systemdUnit(box)).toContain('[security] approvals = "careful"');
    expect(systemdUnit(box)).toContain("the fixed list");
  });

  test("an ordinary install is unchanged by any of this", () => {
    const unit = systemdUnit({ execStart: "/x", workingDir: "/srv/nouride", user: "nouride" });
    for (const directive of [
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "ProtectHome=read-only",
      "RestrictSUIDSGID=true",
      "RestrictNamespaces=true",
      "ReadWritePaths=/srv/nouride",
    ]) {
      expect(unit).toContain(directive);
    }
    expect(unit).not.toContain("PRIVILEGED MODE");
  });

  test("keeps a measured /tmp bounded: a tmpfs is RAM charged to the unit, privileged or not (E8)", () => {
    const unit = systemdUnit({ ...box, tmpSizeBytes: 64 * 1024 * 1024 });
    expect(unit).toContain("TemporaryFileSystem=/tmp:size=67108864,mode=1777");
    // /var/tmp stays the host's, on disk: a file handed to a container's bind mount has to be the one it sees.
    expect(unit).not.toContain("TemporaryFileSystem=/var/tmp");
    expect(unit).not.toContain("PrivateTmp=true");
    // Unmeasured, the host's /tmp, as before.
    expect(systemdUnit(box)).not.toContain("TemporaryFileSystem=");
  });

  test("keeps restart, shutdown budget and journal behaviour identical", () => {
    // Privileged mode relaxes the sandbox and nothing else. These three are what keep a box alive
    // and diagnosable, and they have no bearing on what the agent may do.
    const unit = systemdUnit(box);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("KillSignal=SIGTERM");
    expect(unit).toContain("StandardOutput=journal");
  });
});

/**
 * What the unit adds in 0.7.9 (E8, S17), and the rule that keeps it honest: every directive in it is one the
 * machine's systemd knows. One it does not know is a journal warning and a setting that looks made and is not.
 */
describe("the unit's 0.7.9 directives", () => {
  const base = { execStart: "/srv/nouride/nouride start", workingDir: "/srv/nouride", user: "nouride" };
  const box = { ...base, user: "root", privileged: true };

  test("an OOM kill of one command leaves the daemon up — where systemd has the policy at all", () => {
    // The default, `stop`, stopped the whole unit when the kernel killed any process in it: a runaway build took
    // every gateway and turn down with it.
    for (const params of [base, box]) {
      expect(systemdUnit({ ...params, systemdVersion: 252 })).toMatch(/^OOMPolicy=continue$/m);
      expect(systemdUnit({ ...params, systemdVersion: 243 })).toMatch(/^OOMPolicy=continue$/m);
      // v242 does not know it — and had no stop-on-OOM to turn off. Unknown is treated as the unit's floor.
      expect(systemdUnit({ ...params, systemdVersion: 242 })).not.toContain("OOMPolicy");
      expect(systemdUnit(params)).not.toContain("OOMPolicy");
    }
  });

  test("an ordinary install bounds what the daemon can do with no capability, socket family or realtime slot it needs", () => {
    const unit = systemdUnit({ ...base, systemdVersion: 252 });
    expect(unit).toMatch(/^CapabilityBoundingSet=$/m);
    expect(unit).toMatch(/^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK$/m);
    expect(unit).toMatch(/^RestrictRealtime=true$/m);
  });

  test("and the ones left out on purpose stay out: each would break something an agent does", () => {
    const unit = systemdUnit({ ...base, systemdVersion: 257 });
    // ProtectProc hides other users' processes — an agent asked "is nginx running?" reads no. ProtectClock adds a
    // device allow-list, and with one every device not on it is closed: /dev/dri for ffmpeg, a serial adapter.
    // PrivateDevices the same; SystemCallFilter waits for the Landlock shim; MemoryDenyWriteExecute breaks the JIT.
    for (const absent of ["ProtectProc", "ProtectClock", "PrivateDevices", "SystemCallFilter", "MemoryDenyWriteExecute", "DeviceAllow"]) {
      expect(unit).not.toContain(absent);
    }
  });

  test("the box's privileged unit gains no sandboxing — the agent is meant to operate that machine", () => {
    const unit = systemdUnit({ ...box, systemdVersion: 252 });
    for (const absent of ["CapabilityBoundingSet", "RestrictAddressFamilies", "RestrictRealtime"]) expect(unit).not.toContain(absent);
  });

  test("the systemd version is read from what systemctl prints", () => {
    expect(parseSystemdVersion("systemd 252 (252.30-1~deb12u2)\n+PAM +AUDIT")).toBe(252);
    expect(parseSystemdVersion("systemd 239 (239-78.el8)")).toBe(239);
    expect(parseSystemdVersion("")).toBeNull();
  });
});

describe("the crash-loop backstop", () => {
  test("gives up after a burst, and puts the limit where systemd reads it", () => {
    // Without a limit, Restart=always retries for ever and a config the daemon refuses becomes a
    // silent loop — 29 restarts in two and a half minutes on a live box, with systemctl reporting
    // "activating" the whole time, which reads as "still starting" rather than "has given up".
    //
    // The section matters as much as the directive: systemd moved these to [Unit] in v230, and left
    // in [Service] they are ignored — a limit that looks configured and does nothing.
    const unit = systemdUnit({ execStart: "/srv/nouride/nouride start", workingDir: "/srv/nouride", user: "nouride" });

    // Split on the section *header* — a line that is exactly `[Service]` — not on the first
    // occurrence of that text. The comment above the directives names both sections, and slicing on
    // the raw string cut the unit in the middle of a sentence. systemd is not fooled by that (a
    // header is only a header at the start of a line, and `systemd-analyze verify` passes), but a
    // test that reads the file more loosely than systemd does will lie in one direction or the other.
    const sections = unit.split(/^\[(?=\w+\]$)/m);
    const unitSection = sections.find((part) => part.startsWith("Unit]")) ?? "";
    const serviceSection = sections.find((part) => part.startsWith("Service]")) ?? "";

    expect(unitSection).toContain("StartLimitBurst=5");
    expect(unitSection).toContain("StartLimitIntervalSec=120");
    // And nowhere else: in [Service] these are ignored, so a copy there would be a no-op that looks
    // like configuration.
    expect(serviceSection).not.toMatch(/^StartLimit/m);
  });
});

/**
 * `/tmp` is RAM, and systemd sizes it from the wrong machine.
 *
 * Read off a live 2 GB LXC container: `df` inside the service's namespace advertised **32 GB** free in
 * `/tmp`, because a tmpfs defaults to half of what the kernel reports and lxcfs does not fake that
 * number the way it fakes `/proc/meminfo`. An agent cloned a 1.2 GB repository into it. The pages are
 * charged to the service's cgroup, so it crossed `MemoryHigh`, and the kernel throttled the daemon
 * until its gateways started timing out — `reconnecting reason 408`, `timed out waiting for message`.
 *
 * It never crashed. `NRestarts=0` for the whole episode, every stop in the journal a clean one. From a
 * chat window that is indistinguishable from a daemon that died, which is exactly how it was reported.
 *
 * This is the same mistake `MemoryHigh=80%` made — a limit resolved against the host — in a place with
 * no percentage to get wrong.
 */
describe("the private /tmp is bounded", () => {
  const base = {
    execStart: "/usr/local/bin/nouride start",
    workingDir: "/srv/nouride",
    user: "nouride",
  };
  const sized = (bytes?: number) =>
    systemdUnit({ ...base, ...(bytes === undefined ? {} : { tmpSizeBytes: bytes }) });

  test("a measured machine gets a ceiling, not systemd's guess", () => {
    const unit = sized(256 * 1024 * 1024);

    expect(unit).toContain("TemporaryFileSystem=/tmp:size=268435456,mode=1777");
    // Still private: a tmpfs mounted over the path is invisible to and from the host, which is the
    // whole of what PrivateTmp= bought.
    expect(unit).not.toContain("PrivateTmp=true");
  });

  test("mode 1777, because that is what /tmp is", () => {
    // Left off, the mount comes up 0755 and owned by root: every unprivileged write fails, which
    // breaks far more than the runaway clone this exists to stop.
    expect(sized(64 * 1024 * 1024)).toMatch(/TemporaryFileSystem=\/tmp:size=\d+,mode=1777/);
  });

  test("/var/tmp is smaller, deliberately", () => {
    // It is the one meant to survive a reboot, which is precisely what a tmpfs does not do. Anything
    // reaching for it here is already in the wrong place; it does not also need room to grow.
    const unit = sized(256 * 1024 * 1024);
    expect(unit).toContain("TemporaryFileSystem=/var/tmp:size=67108864,mode=1777");
  });

  test("an unmeasurable machine keeps what it has always had", () => {
    // A unit that cannot describe itself is worse than one that keeps the old behaviour — and the old
    // behaviour is what every existing install is running.
    const unit = sized(undefined);
    expect(unit).toContain("PrivateTmp=true");
    expect(unit).not.toContain("TemporaryFileSystem=");
  });
});
