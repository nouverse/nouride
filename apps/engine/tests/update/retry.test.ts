/**
 * The build an update's guard put aside, back in (`modules/update/retry.ts`, `nouride update --retry`).
 *
 * An update did not come up, the guard put the previous build back, and the new build's parts stood beside the
 * install, each with `.failed` after its name. The old build would not open the database the new one had migrated and
 * said "start the newer build again"; the binary alone was moved back by hand and ran over the older dashboard.
 *
 * The parts are made here by the guard's own script, run as the unit runs it, so what is put back is what a real
 * rollback leaves. The CLI is spawned, as the rollback's is.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keptBuild, swapBack } from "@/modules/update/rollback.ts";
import { putAside, retryRefusal, somethingKept, takeAgain } from "@/modules/update/retry.ts";
import { GUARD_STARTS, PENDING_FILE, ROLLED_BACK_FILE, SWAPPED, guardScript } from "@/service/update-guard.ts";
import { runCli } from "../cli-harness.ts";

let root: string;
let install: string;

/** A part of a build: a file, or a folder with one file in it. Each says which build it is of. */
function part(dir: string, name: string, build: string): void {
  if (name === "nouride") {
    writeFileSync(join(dir, name), `#!/bin/sh\necho ${build}\n`);
    chmodSync(join(dir, name), 0o755);
  } else if (name === "config.example.toml") {
    writeFileSync(join(dir, name), build);
  } else {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "inside"), build);
  }
}
const read = (...path: string[]) => readFileSync(join(install, ...path), "utf8");
/** Which build a part is of, where it stands. */
const build = (name: string, ...under: string[]) => {
  const at = join(install, ...under, name);
  if (!existsSync(at)) return null;
  const said = statSync(at).isDirectory() ? readFileSync(join(at, "inside"), "utf8") : readFileSync(at, "utf8");
  return /0\.8\.\d+/.exec(said)?.[0] ?? said;
};
const everyPart = (...under: string[]) => Object.fromEntries(SWAPPED.map((name) => [name, build(name, ...under)]));
const all = (version: string | null) => Object.fromEntries(SWAPPED.map((name) => [name, version]));

/** A new build installed over the one before it, which is kept; it does not come up, and the guard puts the old one back. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-retry-"));
  install = join(root, "srv");
  mkdirSync(join(install, ".nouride-previous"), { recursive: true });
  for (const name of SWAPPED) {
    part(install, name, "0.8.39");
    part(join(install, ".nouride-previous"), name, "0.8.38");
  }
  writeFileSync(join(install, PENDING_FILE), JSON.stringify({ from: "0.8.38", to: "0.8.39", at: "2026-11-16T03:00:00.000Z" }));
  for (let start = 0; start <= GUARD_STARTS; start++) expect(spawnSync("sh", ["-c", guardScript(install)]).status).toBe(0);
  const data = join(install, ".nouride", "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(install, ".nouride", "config.toml"), `[daemon]\ndata_dir = "${data}"\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("what the guard left", () => {
  test("the previous build in place, and every part of the one that did not start beside it", () => {
    expect(everyPart()).toEqual(all("0.8.38"));
    expect(Object.fromEntries(SWAPPED.map((name) => [name, build(`${name}.failed`)]))).toEqual(all("0.8.39"));
    expect(existsSync(join(install, ROLLED_BACK_FILE))).toBe(true);
  });

  test("is found: its parts in the order they are swapped, and the versions the guard's marker names", () => {
    expect(putAside(install)).toEqual({ names: [...SWAPPED], version: "0.8.39", replaced: "0.8.38" });
    expect(retryRefusal(putAside(install)!, somethingKept(install))).toBeNull();
  });

  test("with the marker gone, as once the previous build has run: the parts still, and no version said", () => {
    rmSync(join(install, ROLLED_BACK_FILE));
    expect(putAside(install)).toEqual({ names: [...SWAPPED], version: null, replaced: null });
    writeFileSync(join(install, ROLLED_BACK_FILE), '{"from":"0.8');
    expect(putAside(install)).toMatchObject({ version: null, replaced: null });
  });

  test("nothing put aside is nothing to take again", () => {
    for (const name of SWAPPED) rmSync(join(install, `${name}.failed`), { recursive: true });
    expect(putAside(install)).toBeNull();
  });
});

describe("when what was put aside is not taken again", () => {
  test("no binary among it: it is not a build that can be started", () => {
    rmSync(join(install, "nouride.failed"));
    const aside = putAside(install)!;
    expect(aside.names).not.toContain("nouride");
    expect(retryRefusal(aside, false)).toContain("has no binary among it (dashboard.failed, skills.failed");
  });

  test("a build kept since: something was installed after the update that did not start", () => {
    // As an install leaves it: the build it replaced, in `.nouride-previous/`.
    part(join(install, ".nouride-previous"), "nouride", "0.8.38");
    expect(somethingKept(install)).toBe(true);
    expect(retryRefusal(putAside(install)!, somethingKept(install))).toContain("something was installed after the update that did not start");
  });
});

describe("taking it again", () => {
  test("every part goes back together, the build that ran meanwhile is kept, and the guard's marker goes", () => {
    const moved = takeAgain(install, putAside(install)!, "0.8.38");
    expect(moved).toEqual([...SWAPPED]);
    expect(everyPart()).toEqual(all("0.8.39"));
    // Whole on one build: the dashboard is the binary's own, which the binary moved back alone never had.
    expect(everyPart(".nouride-previous")).toEqual(all("0.8.38"));
    expect(SWAPPED.filter((name) => existsSync(join(install, `${name}.failed`)))).toEqual([]);
    expect(existsSync(join(install, ROLLED_BACK_FILE))).toBe(false);
    expect(existsSync(join(install, PENDING_FILE))).toBe(false);
    expect(putAside(install)).toBeNull();
    // Kept as an install keeps it, so the way back from here is the rollback's.
    expect(keptBuild(install)).toMatchObject({ version: "0.8.38", by: "0.8.39" });
    expect(swapBack(install)).toEqual([...SWAPPED]);
    expect(everyPart()).toEqual(all("0.8.38"));
    expect(everyPart(".nouride-previous")).toEqual(all("0.8.39"));
  });

  test("a part that cannot go back leaves every part where it was: never half on each build", () => {
    // The dashboard cannot go back: a folder does not rename over a link where the live one would be.
    rmSync(join(install, "dashboard"), { recursive: true });
    symlinkSync(join(install, "nowhere"), join(install, "dashboard"));
    expect(() => takeAgain(install, putAside(install)!, "0.8.38")).toThrow("its files were left as they were");
    expect(build("nouride")).toBe("0.8.38");
    expect(build("nouride.failed")).toBe("0.8.39");
    expect(build("dashboard.failed")).toBe("0.8.39");
    expect(existsSync(join(install, ".nouride-previous", "nouride"))).toBe(false);
    expect(existsSync(join(install, ROLLED_BACK_FILE))).toBe(true);
  });
});

describe("nouride update --retry", () => {
  const cli = async (...args: string[]) => {
    const { code, out, err } = await runCli(["update", "--retry", ...args], { cwd: root, config: join(install, ".nouride", "config.toml") });
    return { code, out: out + err };
  };

  test("says what it would do, and changes nothing until --apply", async () => {
    const said = await cli();
    expect(said.code).toBe(0);
    expect(said.out).toContain("→ v0.8.39");
    expect(said.out).toContain("nouride, dashboard, skills, frontend, run, config.example.toml, put back together");
    expect(said.out).toContain("nouride update --retry --apply does it, with the daemon stopped.");
    expect(everyPart()).toEqual(all("0.8.38"));
    expect(existsSync(join(install, "nouride.failed"))).toBe(true);
  });

  test("with --apply puts every part back, and says how to go back if it does not start this time either", async () => {
    const done = await cli("--apply");
    expect(done.code).toBe(0);
    expect(done.out).toContain("✓ on v0.8.39: nouride, dashboard, skills, frontend, run, config.example.toml put back");
    expect(done.out).toContain("nouride update --rollback --apply goes back to");
    expect(everyPart()).toEqual(all("0.8.39"));
    expect(everyPart(".nouride-previous")).toEqual(all("0.8.38"));
  });

  test("asks the build itself which it is where the marker is gone", async () => {
    rmSync(join(install, ROLLED_BACK_FILE));
    expect((await cli()).out).toContain("→ v0.8.39");
  });

  test("refuses with nothing put aside, with no binary among it, and with a build kept since: exit 1, nothing moved", async () => {
    part(join(install, ".nouride-previous"), "nouride", "0.8.38");
    const kept = await cli("--apply");
    expect(kept.code).toBe(1);
    expect(kept.out).toContain("something was installed after the update that did not start");
    expect(build("nouride")).toBe("0.8.38");
    rmSync(join(install, ".nouride-previous", "nouride"));
    rmSync(join(install, "nouride.failed"));
    const headless = await cli("--apply");
    expect(headless.code).toBe(1);
    expect(headless.out).toContain("has no binary among it");
    expect(build("dashboard")).toBe("0.8.38");
    for (const name of SWAPPED) rmSync(join(install, `${name}.failed`), { recursive: true, force: true });
    const none = await cli();
    expect(none.code).toBe(1);
    expect(none.out).toContain("There is no build an update's guard put aside.");
  });

  test("is in the help, beside the rollback", async () => {
    const help = await runCli(["help"], { cwd: root, config: join(install, ".nouride", "config.toml") });
    expect(help.out).toContain("nouride update --retry [--apply]");
    expect(read(".nouride", "config.toml")).toContain("data_dir");
  });
});
