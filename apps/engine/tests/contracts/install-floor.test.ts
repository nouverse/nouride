/**
 * `install.sh` and the upgrade floor.
 *
 * 0.8.0 upgrades only from the last 0.7.x. A release's checksum file may say so — `# nouride-min-version: 0.7.14` —
 * and every 0.7.x from 0.7.11 records the version that last started in the data directory. install.sh refuses, before
 * anything on the machine changes, a release whose floor this install's data has not crossed, and an install with data
 * and no record (it ran something before 0.7.11); a fresh install is never refused. The functions are taken from the
 * script as written and run by `sh`.
 *
 * And the line must not change what the install.sh already in the field reads: 0.7.10's checksum lookups, copied below
 * as they shipped, are run on a file that carries it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAST_RUN_FILE } from "@/boot/last-run.ts";

const INSTALL = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
const between = (from: string, to: string) => INSTALL.slice(INSTALL.indexOf(from) + from.length, INSTALL.indexOf(to));
const FLOOR = between("# >>> upgrade floor\n", "# <<< upgrade floor");
const SH = existsSync("/bin/sh") ? "/bin/sh" : "sh";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SUMS = "aaaa  ./nouride-linux-x64.tar.gz\nbbbb  ./nouride-router-linux-x64.tar.gz\n";

/** An install directory's data, as the daemon leaves it: a database, and the last-run record when given. */
function install(opts: { floor?: string; data?: boolean; lastRun?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "nouride-floor-sh-"));
  dirs.push(dir);
  const data = join(dir, ".nouride", "data");
  mkdirSync(data, { recursive: true });
  if (opts.data !== false) writeFileSync(join(data, "nouride.db"), "");
  if (opts.lastRun !== undefined) writeFileSync(join(data, LAST_RUN_FILE), opts.lastRun);
  const sums = join(dir, "SHA256SUMS");
  writeFileSync(sums, opts.floor === undefined ? SUMS : `# nouride-min-version: ${opts.floor}\n${SUMS}`);
  return { data, sums };
}

function run(body: string, variant = ""): { out: string; status: number } {
  const script = `die() { echo "DIE: $*"; exit 1; }\nVARIANT='${variant}'\n${FLOOR}\n${body}`;
  const result = spawnSync(SH, ["-c", script], { encoding: "utf8" });
  return { out: result.stdout + result.stderr, status: result.status ?? -1 };
}
const floorCheck = (r: { data: string; sums: string }, variant = "") => run(`check_floor '${r.sums}' '${r.data}' && echo OK`, variant);

describe("install.sh's upgrade floor", () => {
  test("names the record the daemon writes", () => {
    expect(FLOOR).toContain(`LAST_RUN_FILE="${LAST_RUN_FILE}"`);
  });

  test("passes an install whose data last ran the floor's version, or a later one", () => {
    expect(floorCheck(install({ floor: "0.7.14", lastRun: "0.7.14\n" })).out).toBe("OK\n");
    expect(floorCheck(install({ floor: "0.7.14", lastRun: "0.7.20\n" })).out).toBe("OK\n");
  });

  test("refuses one that last ran an older version, and says what to install first", () => {
    const result = floorCheck(install({ floor: "0.7.14", lastRun: "0.7.11\n" }));
    expect(result.status).toBe(1);
    expect(result.out).toContain("this release upgrades only from 0.7.14, and this install last ran 0.7.11. Install 0.7.14 first (sh install.sh --version v0.7.14), start it once, then install this one.");
  });

  test("refuses a pre-release of the floor's version", () => {
    expect(floorCheck(install({ floor: "0.7.14", lastRun: "0.7.14-rc.1\n" })).status).toBe(1);
  });

  test("refuses data with no record: a release before 0.7.11 ran it", () => {
    const result = floorCheck(install({ floor: "0.7.14" }));
    expect(result.status).toBe(1);
    expect(result.out).toContain("no record of the version that last ran it (a release before 0.7.11). Install 0.7.14 first");
  });

  test("tells a Pro install where its release is, not the public download", () => {
    expect(floorCheck(install({ floor: "0.7.14", lastRun: "0.7.11\n" }), "pro").out).toContain("Install 0.7.14 first (take it from the internal release)");
  });

  test("never refuses a fresh install, nor a release that declares no floor", () => {
    expect(floorCheck(install({ floor: "0.7.14", data: false })).out).toBe("OK\n");
    expect(floorCheck(install({ lastRun: "0.6.0\n" })).out).toBe("OK\n");
    expect(floorCheck(install({})).out).toBe("OK\n");
  });

  test("refuses a floor it cannot read rather than guessing", () => {
    expect(floorCheck(install({ floor: "soon", lastRun: "0.7.14\n" })).out).toContain("cannot read (soon)");
  });

  test("orders versions by their numbers, not their text", () => {
    const below = (a: string, b: string) => run(`version_below '${a}' '${b}' && echo yes || echo no`).out.trim();
    expect([below("0.7.9", "0.7.14"), below("0.7.14", "0.7.9"), below("0.9.0", "0.10.0"), below("1.0.0", "0.99.99"), below("0.7.14", "0.7.14")]).toEqual(["yes", "no", "yes", "no", "no"]);
  });

  test("is checked in both ways in, after the checksum and before anything is unpacked or changed", () => {
    const flow = INSTALL.slice(INSTALL.indexOf('step "Fetching the release"'));
    expect(flow.indexOf('    FLOOR_SUMS="$sums"')).toBeGreaterThan(flow.indexOf('    verify_release "$STAGE/nouride.tar.gz" "$sums"'));
    expect(flow.indexOf('  FLOOR_SUMS="$STAGE/$SUMS"')).toBeGreaterThan(flow.indexOf('  verify_release "$STAGE/nouride.tar.gz" "$STAGE/$SUMS"'));
    const check = flow.indexOf('if [ -n "$FLOOR_SUMS" ]; then check_floor "$FLOOR_SUMS" "$INSTALL_DIR/.nouride/data"; fi');
    expect(check).toBeGreaterThan(flow.indexOf('  FLOOR_SUMS="$STAGE/$SUMS"'));
    expect(check).toBeLessThan(flow.indexOf('tar -xzf "$STAGE/nouride.tar.gz"'));
    expect(check).toBeLessThan(flow.indexOf('step "Service account and directory"'));
  });
});

/**
 * install.sh's two checksum lookups exactly as v0.7.10 shipped them (`scripts/install.sh` at the tag, in
 * `verify_release` and `sums_listing`): what a person running the published script, or an older copy of it, reads.
 */
const AWK_0710_WANT = `awk -v name="$2" '{ file = $2; sub(/^\\*/, "", file); sub(/^\\.\\//, "", file); if (file == name) print $1 }' "$1"`;
const AWK_0710_LISTS = `awk -v name="$2" '{ file = $2; sub(/^\\*/, "", file); sub(/^\\.\\//, "", file); if (file == name) found = 1 } END { exit !found }' "$1"`;

describe("the floor line, read by 0.7.10's install.sh", () => {
  test("finds each tarball's checksum as before, and never takes the line for a tarball", () => {
    const { sums } = install({ floor: "0.7.14" });
    const want = (name: string) => spawnSync(SH, ["-c", AWK_0710_WANT, "sh", sums, name], { encoding: "utf8" }).stdout;
    const lists = (name: string) => spawnSync(SH, ["-c", AWK_0710_LISTS, "sh", sums, name]).status;
    expect(want("nouride-linux-x64.tar.gz")).toBe("aaaa\n");
    expect(want("nouride-router-linux-x64.tar.gz")).toBe("bbbb\n");
    expect(lists("nouride-linux-x64.tar.gz")).toBe(0);
    // It is only ever asked for `<artifact>.tar.gz`: for every name a release can publish, the line answers nothing.
    for (const edition of ["", "router-", "pro-"]) {
      for (const target of ["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "darwin-arm64", "darwin-x64"]) {
        expect(want(`nouride-${edition}${target}.tar.gz`)).not.toContain("#");
      }
    }
  });
});
