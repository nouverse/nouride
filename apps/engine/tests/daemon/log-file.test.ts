/**
 * The file launchd writes the daemon's output to, kept to one size (E14).
 *
 * launchd has no journal, so the unit points stdout at `.nouride/data/nouride.log` — and nothing rotated it: a Mac
 * install's log grew for as long as the daemon ran. launchd holds the file open for appending, so it is copied aside
 * and emptied in place; a rename would leave launchd writing into the renamed file.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLogFileRotation } from "@/boot/maintenance.ts";
import { LAUNCHD_LOG_FILE, launchdPlist } from "@/service/unit.ts";

let dir: string;
let path: string;
const timers: ReturnType<typeof setInterval>[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-log-file-"));
  path = join(dir, "nouride.log");
});

afterEach(() => {
  for (const timer of timers.splice(0)) clearInterval(timer);
  rmSync(dir, { recursive: true, force: true });
});

test("past the cap it is set aside and emptied in place — the writer holding it open goes on at the start", () => {
  // As launchd holds it: opened once, for appending.
  const fd = openSync(path, "a");
  try {
    writeSync(fd, "an old line\n".repeat(10));
    timers.push(startLogFileRotation(path, 50));
    expect(readFileSync(`${path}.1`, "utf8")).toBe("an old line\n".repeat(10));
    writeSync(fd, "a new line\n");
    expect(readFileSync(path, "utf8")).toBe("a new line\n");
  } finally {
    closeSync(fd);
  }
});

test("under the cap it is left alone", () => {
  writeFileSync(path, "short\n");
  timers.push(startLogFileRotation(path, 50));
  expect(readFileSync(path, "utf8")).toBe("short\n");
});

test("the file kept to one size is the one the unit points launchd at", () => {
  const plist = launchdPlist({ workingDir: "/Users/g/nouride", execStart: "/usr/local/bin/nouride start", user: "g", env: {} } as never);
  expect(plist).toContain(`<string>/Users/g/nouride/${LAUNCHD_LOG_FILE}</string>`);
});
