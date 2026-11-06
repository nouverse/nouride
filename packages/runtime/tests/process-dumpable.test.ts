/**
 * A non-dumpable daemon's environment is out of reach of the commands it starts.
 *
 * Through a child Bun that seals itself (or not), then runs `cat /proc/<its own pid>/environ` as any command an
 * agent runs would: the same user, a child of the process it reads. Linux only — `/proc/<pid>/environ` is what is
 * being closed — and Linux is where CI runs this on every release branch.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { makeNonDumpable } from "../src/process-dumpable.ts";

const MODULE = join(import.meta.dir, "../src/process-dumpable.ts");

/** What a child of a (sealed or unsealed) process sees when it reads that process's environment. */
function readParentEnvironment(seal: boolean): { sealed: boolean; code: number; saw: boolean } {
  const script = `
    import { makeNonDumpable } from ${JSON.stringify(MODULE)};
    const sealed = ${seal} ? makeNonDumpable() : false;
    const { spawnSync } = require("node:child_process");
    const read = spawnSync("cat", ["/proc/" + process.pid + "/environ"]);
    console.log(JSON.stringify({ sealed, code: read.status, saw: String(read.stdout).includes("NR_DUMPABLE_MARKER=visible") }));
  `;
  const run = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, NR_DUMPABLE_MARKER: "visible" } });
  return JSON.parse(String(run.stdout).trim().split("\n").at(-1) ?? "{}");
}

describe("a non-dumpable process", () => {
  test.skipIf(process.platform !== "linux")("keeps its environment from its children — readable before, refused after", () => {
    expect(readParentEnvironment(false)).toEqual({ sealed: false, code: 0, saw: true });
    const sealed = readParentEnvironment(true);
    expect(sealed.sealed).toBe(true);
    expect(sealed.saw).toBe(false);
    expect(sealed.code).not.toBe(0);
  });

  test.skipIf(process.platform === "linux")("off Linux it does nothing, and says so", () => {
    expect(makeNonDumpable()).toBe(false);
  });
});
