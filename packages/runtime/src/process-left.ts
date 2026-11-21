/**
 * What a command left running when it ended, and ending it later.
 *
 * A command leads a process group of its own (`process-group.ts`), so a timeout or a stop reaches everything it
 * started. A command that ends by itself reaches nothing: what it started and did not wait for stays, in that group,
 * with nobody holding it. On a live box three build workers of a mission that had ended done ran on for eighteen
 * hours, each at a whole core, half the machine, with no job on record; they were found because a restart was about to
 * end them.
 *
 * What stays is read here as the command ends, and ended by whoever started the work, when that work is over
 * (`apps/engine` ends a mission's). Only what is still in the command's own group: a program that set itself apart on
 * purpose, a new session of its own as a process manager or a daemon makes, is in no command's group and is left.
 *
 * ## Whose group it still is
 *
 * A group's number is its first leader's pid, and a number is used again once nothing holds it. So a group is ended
 * only where one of the processes seen in it is still there, the same process and not a later one of its number (its
 * start time tells them apart): while it lived the group was never empty, so its number was never anybody else's.
 * Where none is left, nothing is ended: what could not be proven is left alone.
 */

import type { LeftProcess, LeftRunning } from "@nouride/shared";
import { listDir, readTextFileSync } from "./fs.ts";
import { systemProgram } from "./process-shell.ts";
import { commandGroupOf } from "./process-agents.ts";

const readOrNull = (path: string): string | null => {
  try {
    return readTextFileSync(path);
  } catch {
    return null;
  }
};

/** The processes of a group that still run, a zombie left out: Linux reads `/proc`, any other system asks `ps`. */
export function groupMembers(group: number): LeftProcess[] {
  if (!Number.isInteger(group) || group <= 1) return [];
  if (process.platform === "linux") {
    const members: LeftProcess[] = [];
    for (const entry of listDir("/proc")) {
      if (!/^\d+$/.test(entry.name)) continue;
      const stat = readOrNull(`/proc/${entry.name}/stat`);
      if (!stat) continue;
      // `comm` sits in parentheses and may hold spaces or parentheses itself: count from the last `)`. What follows
      // is state, ppid, pgrp, … with the start time at 19 (the file's 22nd field).
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      if (Number(fields[2]) !== group || fields[0] === "Z") continue;
      members.push({ pid: Number(entry.name), started: fields[19] ?? "", name: stat.slice(stat.indexOf("(") + 1, close) });
    }
    return members;
  }
  try {
    const listed = Bun.spawnSync([systemProgram("ps"), "-axo", "pid=,pgid=,stat=,lstart=,comm="]);
    return new TextDecoder()
      .decode(listed.stdout)
      .split("\n")
      .flatMap((line) => {
        // `  123   120 S    Sat Nov 21 20:11:02 2026 /bin/sleep`: the start is five words.
        const cells = line.trim().split(/\s+/);
        if (cells.length < 9 || Number(cells[1]) !== group || cells[2]!.startsWith("Z")) return [];
        return [{ pid: Number(cells[0]), started: cells.slice(3, 8).join(" "), name: (cells.slice(8).join(" ").split("/").pop() ?? "").trim() }];
      });
  } catch {
    return [];
  }
}

/**
 * What the command a pid stands for left running in its own group, asked as it ends and before it is untracked. Null
 * where nothing is left, and where the command never led a group of its own: its group is then the daemon's.
 */
export function leftRunning(pid: number, ownGroup: boolean): LeftRunning | null {
  if (!ownGroup) return null;
  const group = commandGroupOf(pid);
  const members = groupMembers(group);
  return members.length > 0 ? { group, members } : null;
}

/** The processes in the group now, where it is provably still the group that was seen; none where it cannot be. */
export function stillLeft(left: LeftRunning): LeftProcess[] {
  const now = groupMembers(left.group);
  const same = now.some((one) => left.members.some((seen) => seen.pid === one.pid && seen.started === one.started));
  return same ? now : [];
}

/**
 * Signal a group as the daemon. `refused`: its processes are another user's, an agent's own, and the signal has to be
 * sent as that agent.
 */
export function signalGroup(group: number, signal: NodeJS.Signals): "sent" | "gone" | "refused" {
  if (!Number.isInteger(group) || group <= 1) return "gone";
  try {
    process.kill(-group, signal);
    return "sent";
  } catch (err) {
    return (err as { code?: string }).code === "EPERM" ? "refused" : "gone";
  }
}
