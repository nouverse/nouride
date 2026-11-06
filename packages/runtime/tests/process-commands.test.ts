import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandsRunningUnder } from "../src/process-commands.ts";
import { withOwnProcessGroup } from "../src/process-group.ts";
import { eventually } from "./wait.ts";

const linux = process.platform === "linux";

/** Whether a child of `pid` has ended and is not reaped: state `Z`. */
function zombieUnder(pid: number): boolean {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" && Number(fields[1]) === pid) return true;
    } catch {
      // Gone between the listing and the read.
    }
  }
  return false;
}


describe.skipIf(!linux)("the commands a process still runs", () => {
  test("a command in a session of its own is counted, one in the process's own session is not, and one that ended is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-commands-"));
    const pidFile = join(dir, "own-session.pid");
    // As Claude Code runs a command in the background: a shell that leads its own session, under the process. Beside
    // it, a child in the process's own session — what a CLI holds for itself.
    const proc = Bun.spawn(withOwnProcessGroup(["sh", "-c", `sleep 30 & setsid sh -c 'echo $$ > ${pidFile}; exec sleep 30' & wait`]), { stdout: "ignore", stderr: "ignore" });
    try {
      await eventually(() => commandsRunningUnder(proc.pid) === 1, 4_000, "the command in its own session to be counted");
      const own = Number(readFileSync(pidFile, "utf8").trim());
      process.kill(own, "SIGKILL");
      await eventually(() => commandsRunningUnder(proc.pid) === 0, 4_000, "the ended command to be gone");
    } finally {
      process.kill(-proc.pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a command that ended, not reaped yet, runs no more", async () => {
    // A zombie keeps its line in /proc until its parent reaps it; counted, the CLI was never idle.
    const proc = Bun.spawn(withOwnProcessGroup(["sh", "-c", "setsid true & exec sleep 30"]), { stdout: "ignore", stderr: "ignore" });
    try {
      await eventually(() => zombieUnder(proc.pid), 4_000, "the ended command to be a zombie");
      expect(commandsRunningUnder(proc.pid)).toBe(0);
    } finally {
      process.kill(-proc.pid, "SIGKILL");
    }
  });

  test("a process with nothing under it, or none at all, runs no command", () => {
    expect(commandsRunningUnder(2_147_483_000)).toBe(0);
  });
});

describe.skipIf(linux)("the commands a process still runs, off Linux", () => {
  test("are not read: none is counted", () => {
    expect(commandsRunningUnder(process.pid)).toBe(0);
  });
});
