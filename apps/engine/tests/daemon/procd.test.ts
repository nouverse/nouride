/**
 * OpenWrt's service, and what makes a box there updatable: a declared supervisor, and the update guard.
 *
 * A box made by the Box flasher on OpenWrt read its supervisor as `none`, so every update was refused as "a stop",
 * silently; and it ran no guard, so an update that crashed at start would have used up procd's respawns and stayed
 * down. The init script's command is run here the way procd runs it — the same
 * shell text under `sh` — because that is the half that has to work when the new binary cannot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cannotTakeReporter } from "@/boot/appliance-updates.ts";
import { markPendingUpdate } from "@/modules/update/confirm.ts";
import { procdInitScript } from "@/service/procd.ts";
import { detectSupervisor, nativeSupervisorFor } from "@/service/supervisor.ts";
import { GUARD_STARTS, PENDING_FILE } from "@/service/update-guard.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-procd-"));
  // A daemon that says which build it is, and where it was started.
  const daemon = (build: string) => `#!/bin/sh\necho "${build} $1 $(pwd)" >> "${dir}/started"\n`;
  writeFileSync(join(dir, "nouride"), daemon("NEW"));
  chmodSync(join(dir, "nouride"), 0o755);
  mkdirSync(join(dir, ".nouride-previous"));
  writeFileSync(join(dir, ".nouride-previous", "nouride"), daemon("OLD"));
  chmodSync(join(dir, ".nouride-previous", "nouride"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const script = () => procdInitScript({ execStart: `${dir}/nouride start`, workingDir: dir });
/** The command procd runs, as the shell reading the init script hands it over: the single-quoted argument. */
const command = () => /procd_set_param command \/bin\/sh -c '([^']*)'/.exec(script())![1]!;
const start = () => spawnSync("sh", ["-c", command()], { encoding: "utf8" });
const started = () => (existsSync(join(dir, "started")) ? readFileSync(join(dir, "started"), "utf8").trim().split("\n") : []);

describe("the procd init script", () => {
  test("starts the daemon in its directory when no update is pending — the guard's exit ends only the guard", () => {
    // The guard ends with `exit 0` when nothing is pending; in the same shell, that exit was every boot's.
    expect(start().status).toBe(0);
    expect(started()).toEqual([`NEW start ${dir}`]);
  });

  test(`puts the previous build back after ${GUARD_STARTS} starts of an unconfirmed update, and starts that`, () => {
    markPendingUpdate(dir, { from: "0.7.8", to: "v0.7.9" });
    for (let i = 0; i < GUARD_STARTS; i++) start();
    expect(started().every((line) => line.startsWith("NEW"))).toBe(true);
    const fourth = start();
    expect(fourth.stderr).toContain("restored the previous version");
    expect(started().at(-1)).toBe(`OLD start ${dir}`);
    expect(existsSync(join(dir, PENDING_FILE))).toBe(false);
  });

  test("declares itself, so the daemon knows exiting brings it back", () => {
    expect(script()).toMatch(/^\tprocd_set_param env .*\bNOURIDE_SERVICE_KIND=procd\b/m);
    expect(script()).toContain(`HOME=${dir}/.nouride/home`);
    expect(detectSupervisor({ env: { NOURIDE_SERVICE_KIND: "procd" } })).toEqual({ kind: "procd", evidence: "NOURIDE_SERVICE_KIND", restartsOnExit: true });
  });

  test("gives the shutdown the unit's 45 seconds, and gives up after five quick deaths", () => {
    expect(script()).toContain("procd_set_param term_timeout 45");
    expect(script()).toContain("procd_set_param respawn 3600 5 5");
  });

  test("parses as the shell rc.common sources it", () => {
    const file = join(dir, "nouride.init");
    writeFileSync(file, script());
    expect(spawnSync("sh", ["-n", file]).status).toBe(0);
  });

  test("is what a Linux whose init is procd gets by default", () => {
    expect(nativeSupervisorFor("linux", { procd: true })).toBe("procd");
    expect(nativeSupervisorFor("linux")).toBe("systemd");
  });
});

describe("an offered release a box cannot take", () => {
  test("is said once — to the journal and to the fleet, as an install that did not happen", async () => {
    const reports: { tag: string; outcome: string; reason?: string }[] = [];
    const warnings: string[] = [];
    const say = cannotTakeReporter(async (report) => void reports.push(report), (message) => warnings.push(message));
    for (let tick = 0; tick < 3; tick++) say("v0.7.9", "nothing would restart this daemon after the swap", ["nouride service install"]);
    say("v0.7.10", "nothing would restart this daemon after the swap", []);
    await Promise.resolve();
    expect(reports.map((report) => [report.tag, report.outcome])).toEqual([["v0.7.9", "failed_install"], ["v0.7.10", "failed_install"]]);
    expect(reports[0]!.reason).toBe("this box cannot update itself: nothing would restart this daemon after the swap");
    expect(warnings).toHaveLength(2);
  });

  // That the tick says it, rather than returning in silence, is run in `update/appliance-updates.test.ts`: "an offer
  // this box cannot take is said once". It was read off the source here while the tick could not be called.
});
