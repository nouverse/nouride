/**
 * An update that does not come up puts the previous version back by itself.
 *
 * The guard is run as the unit runs it — the same shell text, under `sh`, against a real directory —
 * because it is the half that has to work when the new binary cannot run at all, and a guard that
 * only looks right in a unit file is the silent no-op this repo keeps finding.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { CONFIRM_WITHIN_MS, markPendingUpdate, rolledBackFrom, watchPendingUpdate, type UpdateReport } from "@/modules/update/confirm.ts";
import { GUARD_STARTS, PENDING_FILE, ROLLED_BACK_FILE, guardScript } from "@/service/update-guard.ts";
import { systemdUnit } from "@/service/unit.ts";
import { eventually, sleep } from "../wait.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-confirm-"));
  // What the install leaves: the new files live, the old ones beside them.
  writeFileSync(join(dir, "nouride"), "NEW");
  mkdirSync(join(dir, "dashboard"));
  writeFileSync(join(dir, "dashboard", "index.html"), "NEW");
  mkdirSync(join(dir, ".nouride-previous", "dashboard"), { recursive: true });
  writeFileSync(join(dir, ".nouride-previous", "nouride"), "OLD");
  writeFileSync(join(dir, ".nouride-previous", "dashboard", "index.html"), "OLD");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const guard = () => spawnSync("sh", ["-c", guardScript(dir)]);
/** The guard's count of starts, beside the marker. */
const attempts = () => join(dir, `${PENDING_FILE}.attempts`);

describe("the unit's guard", () => {
  test("does nothing when no update is pending", () => {
    for (let i = 0; i < 5; i++) expect(guard().status).toBe(0);
    expect(readFileSync(join(dir, "nouride"), "utf8")).toBe("NEW");
  });

  test(`allows ${GUARD_STARTS} starts of an unconfirmed update, then restores the previous version`, () => {
    markPendingUpdate(dir, { from: "0.5.11", to: "v0.5.12" });
    for (let i = 0; i < GUARD_STARTS; i++) {
      expect(guard().status).toBe(0);
      expect(readFileSync(join(dir, "nouride"), "utf8")).toBe("NEW");
    }
    const restore = guard();
    expect(restore.status).toBe(0);
    expect(restore.stderr.toString()).toContain("restored the previous version");
    expect(readFileSync(join(dir, "nouride"), "utf8")).toBe("OLD");
    expect(readFileSync(join(dir, "dashboard", "index.html"), "utf8")).toBe("OLD");
    // The failed files are kept for a person to look at, and the old version is told what happened.
    expect(readFileSync(join(dir, "nouride.failed"), "utf8")).toBe("NEW");
    expect(existsSync(join(dir, PENDING_FILE))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, ROLLED_BACK_FILE), "utf8"))).toMatchObject({ from: "0.5.11", to: "0.5.12" });
  });

  test("counts from nothing for each update: a count left beside an earlier marker is not the new one's", () => {
    // What a version that never became healthy writes, if no guard ran to read it and clear it.
    writeFileSync(attempts(), `${GUARD_STARTS + 99}\n`);
    markPendingUpdate(dir, { from: "0.5.11", to: "v0.5.12" });
    for (let i = 0; i < GUARD_STARTS; i++) guard();
    expect(readFileSync(join(dir, "nouride"), "utf8")).toBe("NEW");
  });

  test("the marker is written for the service account alone, whatever the umask it is written under", () => {
    // The daemon's files are not other users' to read or change (`service.test.ts`, the unit's UMask), and the process
    // that installs may run under a shell's 002, which would leave this one writable by the whole group.
    const before = process.umask(0o002);
    try {
      markPendingUpdate(dir, { from: "0.5.11", to: "v0.5.12" });
    } finally {
      process.umask(before);
    }
    expect(statSync(join(dir, PENDING_FILE)).mode & 0o777).toBe(0o600);
  });

  test("restores the LLM gateway's dashboard with the rest — the update swaps it too", () => {
    mkdirSync(join(dir, "frontend"));
    writeFileSync(join(dir, "frontend", "index.html"), "NEW");
    mkdirSync(join(dir, ".nouride-previous", "frontend"), { recursive: true });
    writeFileSync(join(dir, ".nouride-previous", "frontend", "index.html"), "OLD");
    markPendingUpdate(dir, { from: "0.7.1", to: "v0.7.2" });
    for (let i = 0; i <= GUARD_STARTS; i++) guard();
    expect(readFileSync(join(dir, "frontend", "index.html"), "utf8")).toBe("OLD");
  });

  test("is in the unit exactly, with systemd's $$ escape", () => {
    const unit = systemdUnit({ user: "nouride", workingDir: "/srv/nouride", execStart: "/srv/nouride/nouride start", env: {} } as never);
    const line = unit.split("\n").find((l) => l.startsWith("ExecStartPre="));
    expect(line).toBeDefined();
    const inner = /^ExecStartPre=-\/bin\/sh -c '(.*)'$/.exec(line!)?.[1];
    expect(inner?.replace(/\$\$/g, "$")).toBe(guardScript("/srv/nouride"));
    expect(inner).not.toContain("'");
  });
});

describe("the new version confirming itself", () => {
  const settle = (ms: number) => sleep(ms);

  test("a box that never rolled back has nothing to skip", () => {
    expect(rolledBackFrom(dir)).toBeNull();
  });

  test("once healthy: the marker and its count go, and the fleet is told it installed", async () => {
    markPendingUpdate(dir, { from: "0.5.11", to: "v0.5.12" });
    // Two starts the guard counted before this one came up.
    writeFileSync(attempts(), "2\n");
    const reports: UpdateReport[] = [];
    const timers: ReturnType<typeof setInterval>[] = [];
    watchPendingUpdate({
      installDir: dir,
      version: "0.5.12",
      healthy: () => true,
      report: async (r) => void reports.push(r),
      requestRestart: () => {
        throw new Error("must not restart");
      },
      timers,
      pollMs: 5,
    });
    await settle(40);
    timers.forEach(clearInterval);
    expect(existsSync(join(dir, PENDING_FILE))).toBe(false);
    expect(existsSync(attempts())).toBe(false);
    expect(reports).toEqual([{ tag: "v0.5.12", outcome: "installed" }]);
  });

  test("gives up at the deadline — not a look before it, and not a look after", async () => {
    // A version that gave up at its first unhealthy look would roll back every update slower to come up than fifteen
    // seconds; one that kept waiting past the deadline would hold a broken build for longer than it says.
    markPendingUpdate(dir, { from: "0.5.11", to: "0.5.12" });
    let clock = 0;
    const restarts: string[] = [];
    const timers: ReturnType<typeof setInterval>[] = [];
    watchPendingUpdate({
      installDir: dir,
      version: "0.5.12",
      healthy: () => false,
      requestRestart: (reason) => void restarts.push(reason),
      timers,
      now: () => clock,
      pollMs: 5,
    });
    try {
      // Registered, so shutdown clears it.
      expect(timers).toHaveLength(1);
      clock = CONFIRM_WITHIN_MS - 1;
      await settle(30);
      expect(restarts).toEqual([]);

      clock = CONFIRM_WITHIN_MS;
      await settle(30);
      expect(restarts).toEqual(["v0.5.12 did not become healthy"]);
    } finally {
      timers.forEach(clearInterval);
    }
  });

  test("a health check that throws is not proof: logged, and the update is still given up on at the deadline", async () => {
    // Each look runs on the poll's timer. Thrown out of it, the update was neither confirmed nor given up on — every
    // poll an uncaught exception, which the daemon shuts down on. Bun fails this test on one.
    const warnings: LogEntry[] = [];
    addLogSink((entry) => void (entry.component === "update.confirm" && entry.level === "warn" && warnings.push(entry)));
    markPendingUpdate(dir, { from: "0.5.11", to: "0.5.12" });
    let clock = 0;
    let looks = 0;
    const restarts: string[] = [];
    const timers: ReturnType<typeof setInterval>[] = [];
    watchPendingUpdate({
      installDir: dir,
      version: "0.5.12",
      healthy: () => {
        looks += 1;
        throw new Error("the gateway map is being rebuilt");
      },
      requestRestart: (reason) => void restarts.push(reason),
      timers,
      now: () => clock,
      pollMs: 5,
    });
    try {
      await settle(30);
      expect(looks).toBeGreaterThan(1);
      expect(restarts).toEqual([]);
      clock = CONFIRM_WITHIN_MS;
      await settle(30);
      expect(restarts).toEqual(["v0.5.12 did not become healthy"]);
    } finally {
      timers.forEach(clearInterval);
    }
    expect(warnings[0]).toMatchObject({ message: "could not tell whether this update is healthy", data: { to: "0.5.12", error: "Error: the gateway map is being rebuilt" } });
  });

  test("never healthy: gives up on itself, and the next start's guard restores", async () => {
    markPendingUpdate(dir, { from: "0.5.11", to: "0.5.12" });
    let clock = 0;
    const restarts: string[] = [];
    const timers: ReturnType<typeof setInterval>[] = [];
    watchPendingUpdate({
      installDir: dir,
      version: "0.5.12",
      healthy: () => false,
      requestRestart: (reason) => void restarts.push(reason),
      timers,
      now: () => (clock += 60 * 60_000),
      pollMs: 5,
    });
    await settle(40);
    timers.forEach(clearInterval);
    expect(restarts).toHaveLength(1);
    expect(guard().status).toBe(0);
    expect(readFileSync(join(dir, "nouride"), "utf8")).toBe("OLD");
  });

  test("the version after a rollback reports it, once", () => {
    markPendingUpdate(dir, { from: "0.5.11", to: "0.5.12" });
    for (let i = 0; i <= GUARD_STARTS; i++) guard();
    const reports: UpdateReport[] = [];
    const deps = {
      installDir: dir,
      version: "0.5.11",
      healthy: () => true,
      report: async (r: UpdateReport) => void reports.push(r),
      requestRestart: () => undefined,
      timers: [] as ReturnType<typeof setInterval>[],
    };
    watchPendingUpdate(deps);
    watchPendingUpdate(deps);
    expect(reports).toEqual([{ tag: "v0.5.12", outcome: "rolled_back", reason: "v0.5.12 did not start; back on v0.5.11" }]);
    // …and remembers it, so the nightly schedule does not install the same broken build again.
    expect(rolledBackFrom(dir)).toBe("v0.5.12");
  });

  test("a marker for another version is not this process's to confirm", () => {
    markPendingUpdate(dir, { from: "0.5.11", to: "0.5.12" });
    writeFileSync(attempts(), "1\n");
    const reports: UpdateReport[] = [];
    watchPendingUpdate({
      installDir: dir,
      version: "0.5.11",
      healthy: () => true,
      report: async (r) => void reports.push(r),
      requestRestart: () => undefined,
      timers: [],
    });
    expect(existsSync(join(dir, PENDING_FILE))).toBe(false);
    expect(existsSync(attempts())).toBe(false);
    expect(reports[0]).toMatchObject({ tag: "v0.5.12", outcome: "rolled_back" });
    // Remembered like a rollback the guard did, or the nightly schedule installs the same build again.
    expect(rolledBackFrom(dir)).toBe("v0.5.12");
  });
});

/**
 * A marker missing one of its two fields (`confirm-marker-half-written`). The guard counts every start while the file is
 * there, whatever it holds — so a marker read as none was left for it to count down to restoring a version nobody chose.
 * `to` is the update; without it the update is the version running, which the guard let start. `from` only describes.
 */
describe("a half-written marker", () => {
  const marker = (text: string) => writeFileSync(join(dir, PENDING_FILE), text);
  /** Until the watcher has decided: reported the update installed, or asked for the restart that gives it up. */
  const decided = (w: { reports: UpdateReport[]; restarts: string[] }) => eventually(() => w.reports.length + w.restarts.length > 0, 2_000, "the watcher's decision");
  function watch(version: string, healthy: boolean, clock?: () => number) {
    const reports: UpdateReport[] = [];
    const restarts: string[] = [];
    const timers: ReturnType<typeof setInterval>[] = [];
    watchPendingUpdate({
      installDir: dir,
      version,
      healthy: () => healthy,
      report: async (r) => void reports.push(r),
      requestRestart: (reason) => void restarts.push(reason),
      timers,
      ...(clock ? { now: clock } : {}),
      pollMs: 5,
    });
    return { reports, restarts, done: () => timers.forEach(clearInterval) };
  }

  test("without `from`, it is still the update `to` names: confirmed once healthy, and the guard stops counting", async () => {
    marker(JSON.stringify({ to: "0.5.12" }));
    writeFileSync(attempts(), "2\n");
    const w = watch("0.5.12", true);
    await decided(w);
    w.done();
    expect(existsSync(join(dir, PENDING_FILE))).toBe(false);
    expect(existsSync(attempts())).toBe(false);
    expect(w.reports).toEqual([{ tag: "v0.5.12", outcome: "installed" }]);
  });

  test("without `to`, it is the update to the version running — confirmed once healthy", async () => {
    marker(JSON.stringify({ from: "0.5.11", at: "2026-10-17T00:00:00Z" }));
    const w = watch("0.5.12", true);
    await decided(w);
    w.done();
    expect(existsSync(join(dir, PENDING_FILE))).toBe(false);
    expect(w.reports).toEqual([{ tag: "v0.5.12", outcome: "installed" }]);
  });

  test("…and given up on at the deadline, so the guard's way back is kept", async () => {
    marker(JSON.stringify({ from: "0.5.11" }));
    let clock = 0;
    const w = watch("0.5.12", false, () => (clock += 60 * 60_000));
    await decided(w);
    w.done();
    expect(w.restarts).toEqual(["v0.5.12 did not become healthy"]);
    expect(guard().status).toBe(0);
    expect(readFileSync(join(dir, "nouride"), "utf8")).toBe("OLD");
  });

  test("cut off mid-write it names neither version, and is still watched — not left for the guard to count", async () => {
    marker('{"from":"0.5.11","to":"0.5');
    const w = watch("0.5.12", true);
    await decided(w);
    w.done();
    expect(existsSync(join(dir, PENDING_FILE))).toBe(false);
    expect(w.reports).toEqual([{ tag: "v0.5.12", outcome: "installed" }]);
  });

  test("without `to`, and `from` is what runs: the update did not take — removed, and nothing is reported or remembered", () => {
    marker(JSON.stringify({ from: "v0.5.11" }));
    writeFileSync(attempts(), "1\n");
    const w = watch("0.5.11", true);
    w.done();
    expect(existsSync(join(dir, PENDING_FILE))).toBe(false);
    expect(existsSync(attempts())).toBe(false);
    expect(w.reports).toEqual([]);
    expect(w.restarts).toEqual([]);
    expect(rolledBackFrom(dir)).toBeNull();
    // And the guard has nothing left to count: the version running stays.
    for (let i = 0; i <= GUARD_STARTS; i++) guard();
    expect(readFileSync(join(dir, "nouride"), "utf8")).toBe("NEW");
  });

  test("restored by the guard without `from`: reported as back on the version running, and remembered", () => {
    writeFileSync(join(dir, ROLLED_BACK_FILE), JSON.stringify({ to: "0.5.12" }));
    const w = watch("0.5.11", true);
    w.done();
    expect(w.reports).toEqual([{ tag: "v0.5.12", outcome: "rolled_back", reason: "v0.5.12 did not start; back on v0.5.11" }]);
    expect(rolledBackFrom(dir)).toBe("v0.5.12");
    expect(existsSync(join(dir, ROLLED_BACK_FILE))).toBe(false);
  });

  test("restored by the guard without `to`: nothing names what failed — removed, said in the log, nothing remembered", () => {
    const warnings: LogEntry[] = [];
    addLogSink((entry) => void (entry.component === "update.confirm" && entry.level === "warn" && warnings.push(entry)));
    writeFileSync(join(dir, ROLLED_BACK_FILE), JSON.stringify({ from: "0.5.11" }));
    const w = watch("0.5.11", true);
    w.done();
    expect(w.reports).toEqual([]);
    expect(rolledBackFrom(dir)).toBeNull();
    expect(existsSync(join(dir, ROLLED_BACK_FILE))).toBe(false);
    expect(warnings.map((entry) => entry.message)).toContain("the guard restored the previous version, and its marker does not say which update failed");
  });
});
