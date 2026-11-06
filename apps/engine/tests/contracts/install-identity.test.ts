/**
 * `install.sh --identity`: a Pro server's licence, the device.json Nouverse's admin made for it (0.8.2). Checked before
 * anything on the machine changes — a Pro install only, a file from Nouverse, never written over a licence the install
 * already holds — then put where a box's flashed one is, the daemon's alone to read. The block is taken from the script
 * as written and run by `sh`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
const between = (from: string, to: string) => INSTALL.slice(INSTALL.indexOf(from) + from.length, INSTALL.indexOf(to));
const BLOCK = between("# >>> identity\n", "# <<< identity");
const SH = existsSync("/bin/sh") ? "/bin/sh" : "sh";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LICENCE = { deviceId: "NRD-SERVER-TEST", deviceSecret: "s3cret", endpoint: "https://service.nouverse.tech", appUrl: "https://app.nouverse.tech", edition: "pro", kind: "server" };

function machine(licence: Record<string, unknown> | string = LICENCE) {
  const dir = mkdtempSync(join(tmpdir(), "nouride-identity-sh-"));
  dirs.push(dir);
  const file = join(dir, "device.json");
  writeFileSync(file, typeof licence === "string" ? licence : JSON.stringify(licence, null, 2));
  const data = join(dir, ".nouride", "data");
  mkdirSync(data, { recursive: true });
  return { file, data };
}

function run(body: string, variant = "pro"): { out: string; status: number } {
  const script = `set -e\ndie() { echo "DIE: $*"; exit 1; }\nVARIANT='${variant}'\n${BLOCK}\n${body}`;
  const result = spawnSync(SH, ["-c", script], { encoding: "utf8" });
  return { out: result.stdout + result.stderr, status: result.status ?? -1 };
}

describe("install.sh --identity", () => {
  test("is a Pro install's: any other edition is refused", () => {
    const m = machine();
    const result = run(`check_identity '${m.file}' '${m.data}'`, "");
    expect(result).toMatchObject({ status: 1 });
    expect(result.out).toContain("--identity is a Pro server's licence: pass --variant pro with it");
  });

  test("takes only a device.json from Nouverse, naming what is missing", () => {
    const { deviceSecret: _secret, ...noSecret } = LICENCE;
    expect(run(`check_identity '${machine(noSecret).file}' '${machine().data}'`).out).toContain("it has no deviceSecret");
    expect(run(`check_identity '${machine({ ...LICENCE, endpoint: "" }).file}' '${machine().data}'`).out).toContain("it has no endpoint");
    expect(run(`check_identity '/nonexistent/device.json' '${machine().data}'`).out).toContain("is not a file this can read");
  });

  test("names the licence it was given", () => {
    const m = machine();
    expect(run(`check_identity '${m.file}' '${m.data}'; echo "ID=$IDENTITY_ID"`)).toEqual({ status: 0, out: "ID=NRD-SERVER-TEST\n" });
  });

  test("is put where a box's is, the daemon's alone to read", () => {
    const m = machine();
    // Both from `id`, as the group is: `userInfo()` reads $USER, and a process started without one — an agent's command
    // on the live box — is "unknown", which `install -o` refuses.
    const username = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
    const group = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();
    expect(run(`check_identity '${m.file}' '${m.data}' && place_identity '${m.file}' '${m.data}' '${username}' '${group}'`).status).toBe(0);
    const placed = join(m.data, "appliance", "device.json");
    expect(JSON.parse(readFileSync(placed, "utf8"))).toEqual(LICENCE);
    expect(statSync(placed).mode & 0o777).toBe(0o600);
    expect(statSync(join(m.data, "appliance")).mode & 0o777).toBe(0o700);
    // Run again with the same file — the installer re-run to update by hand — it passes.
    expect(run(`check_identity '${m.file}' '${m.data}'`).status).toBe(0);
  });

  test("takes the same licence again, re-issued: Nouverse's link mints its secret afresh on each run", () => {
    const m = machine();
    mkdirSync(join(m.data, "appliance"));
    writeFileSync(join(m.data, "appliance", "device.json"), JSON.stringify({ ...LICENCE, deviceSecret: "an-earlier-one" }));
    expect(run(`check_identity '${m.file}' '${m.data}'`).status).toBe(0);
  });

  test("never writes another licence over the one an install holds", () => {
    const m = machine();
    mkdirSync(join(m.data, "appliance"));
    writeFileSync(join(m.data, "appliance", "device.json"), JSON.stringify({ ...LICENCE, deviceId: "NRD-SERVER-OTHER" }));
    const result = run(`check_identity '${m.file}' '${m.data}'`);
    expect(result.status).toBe(1);
    expect(result.out).toContain("this install is licensed already, as NRD-SERVER-OTHER");
    expect(JSON.parse(readFileSync(join(m.data, "appliance", "device.json"), "utf8")).deviceId).toBe("NRD-SERVER-OTHER");
  });
});
