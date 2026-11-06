/**
 * Housekeeping is never the reason the process stays alive (E13). A timer that is not `unref`'d holds a CLI command,
 * a test run or a daemon that has finished shutting down open until something kills it — the audit log's flush
 * timer did, while the log buffer's beside it did not.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const engine = join(import.meta.dir, "..", "..");

/** Runs `body` in a fresh process and reports whether it ended by itself within a few seconds. */
function endsByItself(body: string): { ended: boolean; stderr: string } {
  const run = spawnSync(process.execPath, ["-e", body], { cwd: engine, timeout: 5_000, encoding: "utf8" });
  return { ended: run.status === 0 && run.signal === null, stderr: run.stderr };
}

describe("background timers", () => {
  test("the audit log's flush timer does not hold the process open", () => {
    const result = endsByItself(`
      import { openDatabase } from "@nouride/runtime";
      import { AuditLog } from "@/commons/audit.store.ts";
      new AuditLog(openDatabase(":memory:")).start();
    `);
    expect(result.stderr).toBe("");
    expect(result.ended).toBe(true);
  });

  test("the log buffer's does not either", () => {
    const result = endsByItself(`
      import { openDatabase } from "@nouride/runtime";
      import { LogStore } from "@/commons/logs.store.ts";
      new LogStore(openDatabase(":memory:")).start();
    `);
    expect(result.stderr).toBe("");
    expect(result.ended).toBe(true);
  });
});
