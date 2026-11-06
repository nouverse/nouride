/**
 * A command that runs out of time takes what it started with it — on Linux through `setsid(1)`, on macOS through the
 * spawn's `detached` (finding 7 of issue #7 on nouride-releases: no `setsid` there, so a timeout reached `sh` and left
 * its children running, reparented to launchd, for as long as they liked).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { runCommand } from "../src/process.ts";
import { eventually } from "./wait.ts";

/** The pids whose command line is exactly `sleep <seconds>`, read with `pgrep` — on both systems. */
function sleeping(seconds: string): number[] {
  const out = spawnSync("pgrep", ["-f", `^sleep ${seconds}$`], { encoding: "utf8" });
  return out.stdout.split("\n").filter(Boolean).map(Number);
}

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("a timed-out command", () => {
  test("leaves none of the processes it started behind", async () => {
    // Durations nothing else on the machine is sleeping for, so `pgrep` finds only these.
    const [first, second] = ["311.731", "312.913"];
    let started: number[] = [];
    const result = runCommand(["sh", "-c", `sleep ${first} & sleep ${second} & wait`], {
      cwd: tmpdir(),
      timeoutMs: 1_500,
      maxOutputBytes: 4096,
      env,
    });
    // Both are running before the timeout, so the test is about the kill and not about a shell that never forked.
    await eventually(() => (started = [...sleeping(first), ...sleeping(second)]).length === 2, 1_400, "both sleeps to start");

    const done = await result;
    expect(done.timedOut).toBe(true);
    await eventually(() => sleeping(first).length + sleeping(second).length === 0, 3_000, "the sleeps to be gone").catch(() => {});
    const left = [...sleeping(first), ...sleeping(second)];
    // Cleaned up whatever the outcome, so a failure here does not leave two sleeps on the machine running the suite.
    for (const pid of left) spawnSync("kill", ["-9", String(pid)]);
    expect(started).toHaveLength(2);
    expect(left).toEqual([]);
  });
});
