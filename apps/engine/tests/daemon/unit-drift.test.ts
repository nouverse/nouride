/**
 * The installed unit against the one this version writes — and a privileged install putting it right itself.
 *
 * Updates replace the binary and never the unit, so a unit kept what it was installed with: boxes flashed before
 * 2026-10-15 have a guard that restores the binary and not the LLM gateway's dashboard, and no unit got a directive a
 * later release added. `doctor` checked one line of it, `KillMode`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markPendingUpdate, watchPendingUpdate } from "@/modules/update/confirm.ts";
import { compareInstalledUnit, installedUnitParams, refreshPrivilegedUnit, staleSizes, unitDrift, type RefreshDeps } from "@/service/drift.ts";
import { systemdUnit, type UnitParams } from "@/service/unit.ts";
import { sleep } from "../wait.ts";

const ORDINARY: UnitParams = {
  execStart: "/srv/nouride/nouride start",
  workingDir: "/srv/nouride",
  user: "nouride",
  env: { PORT: "18300" },
  envFile: "/srv/nouride/.env",
  memoryHighBytes: 1_717_986_918,
  tmpSizeBytes: 268_435_456,
  systemdVersion: 252,
};
const BOX: UnitParams = { ...ORDINARY, user: "root", privileged: true, env: undefined };
delete BOX.env;

/** A box's unit as flash wrote it before 2026-10-15 and before 0.7.9: the guard without `frontend`, no OOM policy. */
const flashedBefore = (params: UnitParams) =>
  systemdUnit(params)
    .replace("skills frontend run config.example.toml; do", "skills wa-bridge; do")
    .replace(/^.*OOMPolicy.*\n/gm, "")
    .replace(/^# A command the kernel kills for memory.*\n/gm, "");

describe("reading a unit back", () => {
  test("gives what it was written with, so only the template's changes are differences", () => {
    for (const params of [ORDINARY, BOX]) {
      expect(installedUnitParams(systemdUnit(params), 252)).toEqual(params);
      expect(compareInstalledUnit(systemdUnit(params), 252)).toMatchObject({ added: [], removed: [] });
    }
  });

  test("a unit that is not ours is not compared", () => {
    expect(installedUnitParams("[Service]\nExecStart=/usr/bin/something\n")).toBeNull();
    expect(compareInstalledUnit(null)).toBeNull();
  });

  test("an older unit's missing directives are named, comments not counted", () => {
    const drift = unitDrift(flashedBefore(BOX), systemdUnit(BOX));
    expect(drift.added.some((line) => line.startsWith("ExecStartPre=") && line.includes("frontend"))).toBe(true);
    expect(drift.added).toContain("OOMPolicy=continue");
    expect(drift.added.every((line) => !line.startsWith("#"))).toBe(true);
  });
});

describe("a privileged install rewrites its own unit", () => {
  let written: string[] = [];
  let reloads = 0;
  const deps = (installed: string | null, overrides: Partial<RefreshDeps> = {}): RefreshDeps => ({
    read: async () => installed,
    write: async (text) => void written.push(text),
    reload: async () => {
      reloads += 1;
      return true;
    },
    systemdVersion: 252,
    root: true,
    log: { info: () => undefined, warn: () => undefined },
    ...overrides,
  });
  beforeEach(() => {
    written = [];
    reloads = 0;
  });

  test("as root, an older unit of its own is replaced by this version's and systemd is told", async () => {
    expect(await refreshPrivilegedUnit(deps(flashedBefore(BOX)))).toBe(true);
    expect(written).toEqual([systemdUnit(BOX)]);
    expect(reloads).toBe(1);
  });

  test("and nothing else is: a current unit, an ordinary install's, someone else's, or as any other user", async () => {
    expect(await refreshPrivilegedUnit(deps(systemdUnit(BOX)))).toBe(false);
    // An ordinary install's unit is root's and its daemon is not; doctor says it is due, install.sh rewrites it.
    expect(await refreshPrivilegedUnit(deps(flashedBefore(ORDINARY)))).toBe(false);
    expect(await refreshPrivilegedUnit(deps("[Service]\nExecStart=/usr/bin/other\n"))).toBe(false);
    expect(await refreshPrivilegedUnit(deps(flashedBefore(BOX), { root: false }))).toBe(false);
    expect({ written, reloads }).toEqual({ written: [], reloads: 0 });
  });
});

describe("when it happens", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nouride-unit-drift-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("after the new version has confirmed itself, never before", async () => {
    const order: string[] = [];
    let healthy = false;
    const timers: ReturnType<typeof setInterval>[] = [];
    markPendingUpdate(dir, { from: "0.7.8", to: "v0.7.9" });
    watchPendingUpdate({
      installDir: dir,
      version: "0.7.9",
      healthy: () => healthy,
      report: async (report) => void order.push(report.outcome),
      requestRestart: () => undefined,
      onConfirmed: async () => void order.push("refreshed"),
      timers,
      pollMs: 5,
    });
    await sleep(30);
    expect(order).toEqual([]);
    healthy = true;
    await sleep(30);
    timers.forEach(clearInterval);
    expect(order).toEqual(["installed", "refreshed"]);
  });
});

describe("the sizes a unit was measured with (D17)", () => {
  test("a machine that has since been resized is said, by how much — a quarter off or more", () => {
    // `MemoryHigh` and the `/tmp` tmpfs are measured when the unit is written, and carried over by the comparison on
    // purpose; so a container given four times the memory kept its 1.6 GiB ceiling, and nothing said.
    const unit = systemdUnit(ORDINARY);
    expect(staleSizes(unit, { memoryHighBytes: ORDINARY.memoryHighBytes! * 4, tmpSizeBytes: ORDINARY.tmpSizeBytes! * 4 })).toEqual([
      expect.stringContaining("MemoryHigh is 1.6 GiB"),
      expect.stringContaining("/tmp is a 0.3 GiB tmpfs"),
    ]);
  });

  test("the same machine measured twice is quiet, and a unit that is not ours says nothing", () => {
    expect(staleSizes(systemdUnit(ORDINARY), { memoryHighBytes: ORDINARY.memoryHighBytes! * 1.1, tmpSizeBytes: ORDINARY.tmpSizeBytes })).toEqual([]);
    expect(staleSizes("[Service]\nExecStart=/usr/bin/other\n", { memoryHighBytes: 1 })).toEqual([]);
  });
});
