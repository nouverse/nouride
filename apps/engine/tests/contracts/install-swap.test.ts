/**
 * What an upgrade replaces is one list, the engine's `SWAPPED`, and `install.sh` keeps and installs exactly that.
 *
 * It was written out five times — install.sh's `keep_previous`, the update plugin, the unit's guard, and twice in
 * the Box flasher — so a new artefact had to be added in five places, and all five still kept `wa-bridge` long after the last
 * edition stopped shipping one. The engine's list now drives the update plugin and the guard, and flash imports it;
 * install.sh is a script piped to a shell and cannot, so it carries a copy between markers that this holds to it.
 *
 * And the account's group: `-g $SERVICE_USER` stopped every macOS install at its home step, where no group is named
 * after a person. The functions are taken from the script as written and run by `sh`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SWAPPED } from "@/service/update-guard.ts";

const INSTALL = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
const between = (from: string, to: string) => INSTALL.slice(INSTALL.indexOf(from) + from.length, INSTALL.indexOf(to));
const SWAP_BLOCK = between("# >>> swapped\n", "# <<< swapped");
const GROUP_BLOCK = between("# >>> service group\n", "# <<< service group");
const HOME_BLOCK = between("# >>> home\n", "# <<< home");
const me = (flag: "-un" | "-gn") => spawnSync("id", [flag], { encoding: "utf8" }).stdout.trim();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sh = (script: string) => spawnSync("sh", ["-c", `set -eu\nsay() { echo "$*"; }\n${script}`], { encoding: "utf8" });

describe("install.sh's copy of the list", () => {
  test("is the engine's SWAPPED, name for name", () => {
    const listed = /^SWAPPED="([^"]*)"$/m.exec(SWAP_BLOCK)?.[1]?.split(" ");
    expect(listed).toEqual([...SWAPPED]);
  });

  test("names no bridge beside the binary and no pkg/: the one is gone, the other is root's", () => {
    expect(SWAPPED).not.toContain("wa-bridge");
    expect(SWAPPED).not.toContain("pkg");
  });

  test("is what both installs use: the build replaced is kept first, then the rest beside the binary", () => {
    const flow = INSTALL.slice(INSTALL.indexOf("# <<< swapped"));
    expect(flow.indexOf("keep_previous \"$(")).toBeGreaterThan(-1);
    expect(flow.match(/^ {2}install_beside$/gm)).toHaveLength(2);
    expect(flow.indexOf("keep_previous \"$(")).toBeLessThan(flow.indexOf("  install_beside"));
  });
});

describe("an upgrade by install.sh", () => {
  /** An install of `old`, a staged release of `next` carrying every name in SWAPPED — and `pkg/` and an old bridge. */
  function upgrade(): { install: string; stage: string; run: ReturnType<typeof sh> } {
    const dir = mkdtempSync(join(tmpdir(), "nouride-swap-"));
    dirs.push(dir);
    const install = join(dir, "srv");
    const stage = join(dir, "stage");
    for (const [root, version] of [[install, "0.7.9"], [stage, "0.7.10"]] as const) {
      mkdirSync(root, { recursive: true });
      for (const name of SWAPPED) {
        if (name === "nouride" || name.includes(".")) writeFileSync(join(root, name), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
        else {
          mkdirSync(join(root, name));
          writeFileSync(join(root, name, "version"), version);
        }
      }
    }
    for (const extra of ["pkg", "wa-bridge"]) {
      mkdirSync(join(stage, extra));
      writeFileSync(join(stage, extra, "version"), "0.7.10");
    }
    const run = sh(
      `STAGE='${stage}'\nINSTALL_DIR='${install}'\nSERVICE_USER='${me("-un")}'\nSERVICE_GROUP='${me("-gn")}'\n${SWAP_BLOCK}\n` +
        // The binary is installed by each OS's own branch; the rest is the block's.
        `keep_previous v0.7.10\ncp "$STAGE/nouride" "$INSTALL_DIR/nouride"\ninstall_beside\n`,
    );
    return { install, stage, run };
  }

  const read = (root: string, name: string) =>
    readFileSync(statSync(join(root, name)).isDirectory() ? join(root, name, "version") : join(root, name), "utf8");

  test("replaces every name in SWAPPED, and keeps every one it replaced for the way back", () => {
    const { install, run } = upgrade();
    expect(run.status).toBe(0);
    for (const name of SWAPPED) {
      expect([name, read(install, name)]).toEqual([name, expect.stringContaining("0.7.10")]);
      expect([name, read(join(install, ".nouride-previous"), name)]).toEqual([name, expect.stringContaining("0.7.9")]);
    }
    expect(JSON.parse(readFileSync(join(install, ".nouride-previous", "release.json"), "utf8"))).toMatchObject({ by: "v0.7.10" });
  });

  test("and puts nothing else from the release beside the binary", () => {
    // `pkg/` goes to /usr/local/lib/nouride-pkg as root, and only with --allow-packages; a bridge directory is what an
    // older tarball carried, and nothing runs it.
    const { install } = upgrade();
    expect(existsSync(join(install, "pkg"))).toBe(false);
    expect(existsSync(join(install, "wa-bridge"))).toBe(false);
  });
});

describe("the account's group", () => {
  const group = (os: string) => sh(`OS='${os}'\nSERVICE_USER='${me("-un")}'\n${GROUP_BLOCK}\necho "$SERVICE_GROUP"`).stdout.trim();

  test("on macOS is the person's own primary group, on Linux the one useradd makes beside the account", () => {
    expect(group("Darwin")).toBe(me("-gn"));
    expect(group("Linux")).toBe(me("-un"));
  });

  test.skipIf(process.platform !== "darwin")("lets the home step finish on a Mac, for the account running it", () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-home-"));
    dirs.push(dir);
    const run = sh(`OS=Darwin\nINSTALL_DIR='${dir}'\nSERVICE_USER='${me("-un")}'\n${GROUP_BLOCK}\n${HOME_BLOCK}`);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(statSync(join(dir, ".nouride", "home")).mode & 0o777).toBe(0o700);
  });
});
