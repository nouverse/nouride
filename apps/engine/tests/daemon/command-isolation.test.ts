/**
 * What agents run, in a cgroup apart from the daemon (0.7.19): the unit that hands the daemon its cgroup, the drift
 * that brings an older unit to it, and where an operator reads whether it took — `/health` and `nouride doctor`.
 *
 * Written after a 2 GB box went quiet for three quarters of an hour: an agent's typecheck and test suite held the whole
 * unit over `MemoryHigh`, and the kernel throttled the daemon with them. The split itself is `process-cgroup.test.ts`'s.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonContext } from "@/commons/context.ts";
import { commandsCheck } from "@/cli/commands/doctor-checks.ts";
import { buildHealth, installFingerprint } from "@/modules/web/health.ts";
import { compareInstalledUnit, installedUnitParams } from "@/service/drift.ts";
import { systemdUnit, type UnitParams } from "@/service/unit.ts";
import { runCli } from "../cli-harness.ts";

const ORDINARY: UnitParams = { execStart: "/srv/nouride/nouride start", workingDir: "/srv/nouride", user: "nouride", memoryHighBytes: 1_717_986_918, tmpSizeBytes: 268_435_456 };
const BOX: UnitParams = { ...ORDINARY, user: "root", privileged: true };

describe("the unit", () => {
  test("hands the daemon its cgroup, and says so — ordinary install and box alike", () => {
    for (const params of [ORDINARY, BOX]) {
      for (const systemdVersion of [252, 257]) {
        const unit = systemdUnit({ ...params, systemdVersion });
        expect(unit).toMatch(/^Delegate=yes$/m);
        expect(unit).toMatch(/^Environment=NOURIDE_CGROUP=delegated$/m);
      }
    }
  });

  test("never makes the cgroup filesystem read-only: its own view where systemd has one (257), no line before it", () => {
    expect(systemdUnit({ ...ORDINARY, systemdVersion: 257 })).toMatch(/^ProtectControlGroups=private$/m);
    for (const systemdVersion of [256, 252, undefined]) {
      const unit = systemdUnit({ ...ORDINARY, ...(systemdVersion ? { systemdVersion } : {}) });
      expect(unit).not.toMatch(/^ProtectControlGroups=/m);
    }
    // The rest of the hardening is as it was.
    expect(systemdUnit({ ...ORDINARY, systemdVersion: 252 })).toMatch(/^ProtectKernelModules=true$/m);
  });

  test("an older unit is told what it lacks, and reading the new one back carries nothing twice", () => {
    // 0.7.18's: read-only cgroups, nothing handed over.
    const before = systemdUnit({ ...ORDINARY, systemdVersion: 257 })
      .replace(/^Delegate=yes\n/m, "")
      .replace(/^Environment=NOURIDE_CGROUP=delegated\n/m, "")
      .replace(/^ProtectControlGroups=private$/m, "ProtectControlGroups=true");
    const drift = compareInstalledUnit(before, 257);
    expect(drift?.added).toEqual(expect.arrayContaining(["Delegate=yes", "Environment=NOURIDE_CGROUP=delegated", "ProtectControlGroups=private"]));
    expect(drift?.removed).toContain("ProtectControlGroups=true");
    // The marker is the template's own line, not an environment the install chose: kept out of what is read back.
    expect(installedUnitParams(systemdUnit({ ...ORDINARY, env: { PORT: "18300" }, systemdVersion: 252 }), 252)?.env).toEqual({ PORT: "18300" });
    expect(compareInstalledUnit(systemdUnit({ ...ORDINARY, systemdVersion: 252 }), 252)).toMatchObject({ added: [], removed: [] });
  });
});

const running = {
  gateways: new Map(),
  db: { walSizeBytes: () => 0 },
  config: { daemon: { dataDir: "/tmp/nr-health" } },
  providerErrors: new Map(),
  status: "running",
  startedAt: Date.now(),
  agentCount: 1,
} as unknown as DaemonContext;

describe("where it is read", () => {
  test("/health says what boot found, and nothing when it has nothing to say", () => {
    const commands = { isolated: true, systemd: true, commandsMaxBytes: 1_373_634_560, daemonMinBytes: 343_932_928, cpu: true };
    expect(buildHealth({ ...running, commands } as DaemonContext).payload.commands).toEqual(commands);
    expect(buildHealth(running).payload).not.toHaveProperty("commands");
  });

  test("doctor: a line when they are apart, a warning under systemd when they are not, a plain line elsewhere", () => {
    expect(commandsCheck({ isolated: true, systemd: true, commandsMaxBytes: 1_373_634_560, daemonMinBytes: 343_932_928 })).toEqual({
      level: "ok",
      message: "agents' commands: a cgroup of their own, where together they may hold 1.3GB before the kernel stops one, and the daemon keeps 328.0MB",
    });
    const stale = commandsCheck({ isolated: false, systemd: true, reason: "the service unit does not hand its cgroup over — it was written before 0.7.19" });
    expect(stale?.level).toBe("warn");
    expect(stale?.message).toBe("agents' commands share the daemon's memory: the service unit does not hand its cgroup over — it was written before 0.7.19");
    expect(stale?.hint).toContain("Re-run install.sh");
    expect(commandsCheck({ isolated: false, systemd: false, reason: "not started by a service unit that hands its cgroup over" })).toEqual({
      level: "ok",
      message: "agents' commands: beside the daemon (not started by a service unit that hands its cgroup over), the kernel's first choice when memory runs out",
    });
    expect(commandsCheck(undefined)).toBeNull();
  });

  const dir = mkdtempSync(join(tmpdir(), "nouride-doctor-commands-"));
  let server: Server;
  beforeAll(async () => {
    const data = join(dir, "data");
    // A daemon on a unit from before 0.7.19, as doctor reads it.
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        return void res.end(
          JSON.stringify({
            status: "ok",
            version: "0.7.19",
            uptime: 5,
            install: installFingerprint(data),
            memory: { rssBytes: 1, heapUsedBytes: 1 },
            commands: { isolated: false, systemd: true, reason: "the service unit does not hand its cgroup over — it was written before 0.7.19" },
          }),
        );
      }
      if (req.url === "/api/control/status") return void res.end(JSON.stringify({ uptime: 5, providers: [], failures: [], agents: [], gateways: [], pendingApprovals: 0, queue: { waiting: 0 } }));
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not here" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, ".control-token"), "token\n", { mode: 0o640 });
    writeFileSync(join(dir, "config.toml"), `[daemon]\ndata_dir = "${data}"\n\n[dashboard]\nport = ${(server.address() as { port: number }).port}\n`);
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("doctor reads it from the running daemon", async () => {
    const run = await runCli(["doctor", "--json"], { cwd: dir, config: join(dir, "config.toml") });
    const results = JSON.parse(run.out).data.results as { level: string; message: string }[];
    expect(results).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringContaining("agents' commands share the daemon's memory") }));
  });
});
