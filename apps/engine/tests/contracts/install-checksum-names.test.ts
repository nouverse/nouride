/**
 * `install.sh` and 0.8.0's checksum file name.
 *
 * 0.8.0 publishes its checksum files as `CHECKSUMS` (and `CHECKSUMS-<edition>`), with no `SHA256SUMS`, so the updaters
 * from before 0.7.11 — which know no upgrade floor and pick a release by `SHA256SUMS` — stop at the last 0.7.x
 * (`CHECKSUMS_RENAMED_IN`, packages/update/src/edition.ts). install.sh has to find both: by the tag when it is given,
 * and for `latest` by what the newest release carries. The functions are taken from the script as written and run by
 * `sh`, against releases laid out as directories and fetched over `file://`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksumName } from "../../../../packages/update/src/edition.ts";

const INSTALL = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
const between = (from: string, to: string) => INSTALL.slice(INSTALL.indexOf(from) + from.length, INSTALL.indexOf(to));
const NAMES = between("# >>> checksum names\n", "# <<< checksum names");
const FETCH = INSTALL.slice(INSTALL.indexOf("# >>> downloads\n"), INSTALL.indexOf("# <<< downloads"));
const LISTING = INSTALL.slice(INSTALL.indexOf("sums_listing() {"), INSTALL.indexOf("# Whether a release must be signed"));
const SH = existsSync("/bin/sh") ? "/bin/sh" : "sh";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(body: string): { out: string; status: number } {
  const script = `set -eu\nwarn() { echo "WARN: $*" >&2; }\ndie() { echo "DIE: $*"; exit 1; }\n${FETCH}\n${NAMES}\n${LISTING}\n${body}`;
  const result = spawnSync(SH, ["-c", script], { encoding: "utf8", env: { ...process.env, NOURIDE_FETCH_WAITS: "0 0 0 0" } });
  return { out: (result.stdout + result.stderr).trim(), status: result.status ?? -1 };
}

/** A release directory carrying `files`, and an empty stage to download into. */
function release(files: string[]): { url: string; dir: string; stage: string } {
  const root = mkdtempSync(join(tmpdir(), "nouride-sums-sh-"));
  dirs.push(root);
  const dir = join(root, "release");
  const stage = join(root, "stage");
  mkdirSync(dir);
  mkdirSync(stage);
  for (const file of files) writeFileSync(join(dir, file), `aaaa  ./nouride-linux-x64.tar.gz\n`);
  return { url: `file://${dir}`, dir, stage };
}

describe("install.sh's checksum names", () => {
  test("by the tag: SHA256SUMS through 0.7.x, CHECKSUMS from 0.8.0 — as the updater names them", () => {
    for (const tag of ["v0.7.20", "v0.7.21", "v0.8.0", "v0.8.12", "v1.0.0", "v0.8.0-rc.1"]) {
      expect(run(`sums_base_for '${tag}'`).out).toBe(checksumName("basic", tag));
    }
    expect(run("sums_base_for latest").out).toBe("");
  });

  test("a tag takes its own name, a variant after a dash", () => {
    const r = release(["CHECKSUMS-router"]);
    expect(run(`fetch_sums '${r.url}' v0.8.0 router '${r.stage}' && echo "$SUMS"`).out).toBe("CHECKSUMS-router");
    expect(existsSync(join(r.stage, "CHECKSUMS-router"))).toBe(true);
  });

  test("latest on a 0.8.x release is its CHECKSUMS, and on a 0.7.x one its SHA256SUMS", () => {
    const eight = release(["CHECKSUMS", "SHA256SUMS-unrelated"]);
    expect(run(`fetch_sums '${eight.url}' latest '' '${eight.stage}' && echo "$SUMS"`).out).toBe("CHECKSUMS");
    const seven = release(["SHA256SUMS"]);
    expect(run(`fetch_sums '${seven.url}' latest '' '${seven.stage}' && echo "$SUMS"`).out).toBe("SHA256SUMS");
  });

  test("a release with neither is refused, naming the file it looked for", () => {
    const none = release([]);
    const result = run(`fetch_sums '${none.url}' latest '' '${none.stage}' && echo "$SUMS"`);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("DIE: the release has no SHA256SUMS");
  });

  test("a --tarball install finds a CHECKSUMS file beside it", () => {
    const r = release(["CHECKSUMS-pro"]);
    expect(run(`sums_listing '${r.dir}' nouride-linux-x64.tar.gz`).out).toBe(join(r.dir, "CHECKSUMS-pro"));
  });
});
