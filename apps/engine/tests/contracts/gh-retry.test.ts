/**
 * A release's call to GitHub is tried again when it fails. One 500 from the API, on a release asset's download, stopped
 * a public release at a job with nothing wrong with it; a rerun of that job passed. `scripts/release/gh-retry.sh`
 * runs a command up to four times, and every `gh release download` in the release workflows goes through it, with
 * `--clobber` so a try that left a partial file does not refuse the next.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SCRIPT = join(ROOT, "scripts/release/gh-retry.sh");

/** A command that fails `fails` times, counting its runs in a file, then succeeds. */
function flaky(fails: number) {
  const dir = mkdtempSync(join(tmpdir(), "gh-retry-"));
  const count = join(dir, "count");
  writeFileSync(count, "0");
  const cmd = join(dir, "cmd.sh");
  writeFileSync(cmd, `n=$(cat "${count}"); n=$((n + 1)); echo "$n" > "${count}"; [ "$n" -gt ${fails} ] || exit 7\n`);
  const run = () => spawnSync("sh", [SCRIPT, "sh", cmd], { env: { ...process.env, GH_RETRY_WAITS: "0 0 0" }, encoding: "utf8" });
  return { run, runs: () => Number(readFileSync(count, "utf8").trim()), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("gh-retry.sh", () => {
  test("a command that fails twice passes on its third try, and says so for each failed one", () => {
    const cmd = flaky(2);
    try {
      const result = cmd.run();
      expect(result.status).toBe(0);
      expect(cmd.runs()).toBe(3);
      expect(result.stderr.match(/::warning::try \d failed \(exit 7\)/g)?.length).toBe(2);
    } finally {
      cmd.done();
    }
  });

  test("one that never passes is tried four times and ends with its own exit code", () => {
    const cmd = flaky(99);
    try {
      const result = cmd.run();
      expect(result.status).toBe(7);
      expect(cmd.runs()).toBe(4);
    } finally {
      cmd.done();
    }
  });

  test("one that passes at once runs once", () => {
    const cmd = flaky(0);
    try {
      expect(cmd.run().status).toBe(0);
      expect(cmd.runs()).toBe(1);
    } finally {
      cmd.done();
    }
  });
});

describe("the release workflows", () => {
  for (const file of ["release.yml", "public-release.yml"]) {
    test(`${file}: every release download goes through gh-retry.sh, with --clobber`, () => {
      const lines = readFileSync(join(ROOT, ".github/workflows", file), "utf8").split("\n");
      const downloads = lines.filter((line) => /\bgh release download\b/.test(line));
      expect(downloads.length).toBeGreaterThan(0);
      expect(downloads.filter((line) => !line.includes("sh scripts/release/gh-retry.sh gh release download"))).toEqual([]);
      expect(downloads.filter((line) => !line.includes("--clobber"))).toEqual([]);
    });
  }
});
