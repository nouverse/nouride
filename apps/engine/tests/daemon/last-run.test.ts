/**
 * The version that last started here: `<dataDir>/last-run-version`, written once the daemon is ready.
 *
 * The upgrade floor's record: install.sh refuses a release whose floor this install's data has not crossed, and 0.8.0
 * refuses to start on data the last 0.7.x never ran on. Both read this one line, so it is written whole (atomically),
 * by the real boot — held here by booting it — and a failure to write it costs a warning, never the daemon.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { LAST_RUN_FILE, recordLastRun } from "@/boot/last-run.ts";
import { VERSION } from "@/cli/version.ts";
import { eventually } from "../wait.ts";

const entries: LogEntry[] = [];
addLogSink((entry) => entries.push(entry));

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-last-run-"));
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe("the last-run record", () => {
  test("is the version on one line, replacing the one before, with no temp file left beside it", async () => {
    writeFileSync(join(dir, LAST_RUN_FILE), "0.7.11\n");
    await recordLastRun(dir, "0.7.14");
    expect(readFileSync(join(dir, LAST_RUN_FILE), "utf8")).toBe("0.7.14\n");
    expect(readdirSync(dir)).toEqual([LAST_RUN_FILE]);
  });

  test.skipIf(process.getuid?.() === 0)("that cannot be written is a warning, not a failed boot", async () => {
    chmodSync(dir, 0o500);
    await recordLastRun(dir, "0.7.14");
    expect(existsSync(join(dir, LAST_RUN_FILE))).toBe(false);
    expect(entries.some((entry) => entry.level === "warn" && entry.message === "could not record which version last ran here")).toBe(true);
  });

  test("is written by the daemon's own boot, once it is ready", async () => {
    const config = join(dir, "config.toml");
    mkdirSync(join(dir, "memory"));
    writeFileSync(
      config,
      [
        "[daemon]",
        `data_dir = "${join(dir, "data")}"`,
        `agents_dir = "${join(dir, "agents")}"`,
        `workspace_dir = "${join(dir, "workspace")}"`,
        "[memory]",
        `dir = "${join(dir, "memory")}"`,
        "[dashboard]",
        "enabled = false",
        "[nougate]",
        "in_process = false",
        "",
      ].join("\n"),
    );
    // Nothing from this shell may point the daemon at a real install.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(NOURIDE_|NOUGATE_|INITIAL_ADMIN_)/.test(name) && !["PORT", "HOST", "LOG_LEVEL"].includes(name)));
    const child = spawn("bun", [join(import.meta.dir, "../../src/index.ts")], { cwd: dir, env: { ...env, NOURIDE_CONFIG: config }, stdio: "ignore" });
    try {
      const record = join(dir, "data", LAST_RUN_FILE);
      await eventually(() => existsSync(record), 30_000, "the daemon to record the version that started");
      expect(readFileSync(record, "utf8")).toBe(`${VERSION}\n`);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("close", resolve));
    }
  }, 45_000);
});
