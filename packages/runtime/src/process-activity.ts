/**
 * What a process group was doing when it was stopped: data moved and CPU used, read from `/proc`.
 *
 * Exists for one decision. A command killed at its timeout is either working and short of time — a
 * download, a compile — or waiting: on purpose (a `sleep`, a CI run), or on something more time will
 * not bring (a host that does not answer, a prompt). Its output cannot tell these apart when there is
 * none, and there often is none: Claude Code's installer prints nothing while it downloads 257 MB,
 * and was killed twice on the live box, the second time after a hint called the network down. The
 * kernel can tell: a group that wrote 57 MB in thirty seconds was not stuck.
 *
 * Linux only. Null elsewhere, or when nothing in the group can be read — the caller then says less,
 * never something wrong.
 */

import { listDir, readTextFileSync } from "./fs.ts";
import { commandGroupOf } from "./process-agents.ts";

export interface ProcessGroupActivity {
  /**
   * `rchar` + `wchar`: bytes through read and write calls — files, pipes, terminals. Null where none of the group's
   * counts could be read: a command running as its agent's own user is another user's, and its `io` is not the
   * daemon's to read, while its CPU is.
   */
  bytesMoved: number | null;
  cpuSeconds: number;
}

/** `USER_HZ`, the unit of the CPU fields in `/proc/<pid>/stat`: 100 on every Linux the binary targets. */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Totals for every process in the group, the children it already reaped included.
 *
 * The group is the command's own: `runCommand` starts it under `setsid`, so its pid is the group id
 * and everything it spawns stays in it. A reaped child's CPU lands in its parent's `cutime`/`cstime`
 * and its I/O in the parent's `io`, while a live child is counted on its own line — so nothing is
 * counted twice. Socket reads made with `recv` are not in `rchar`; what a download writes to its file
 * or its pipe is in `wchar`, and that is the half that shows it.
 */
export function processGroupActivity(pid: number): ProcessGroupActivity | null {
  if (process.platform !== "linux") return null;
  // The command's own group where the daemon holds a client for it (`process-agents.ts`).
  const groupId = commandGroupOf(pid);
  let bytesMoved: number | null = null;
  let ticks = 0;
  let members = 0;
  for (const entry of listDir("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    const stat = readOrNull(`/proc/${entry.name}/stat`);
    if (!stat) continue;
    // `comm` sits in parentheses and may hold spaces or parentheses itself: count from the last `)`.
    // What follows is state, ppid, pgrp, … with utime, stime, cutime and cstime at 11–14.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) !== groupId) continue;
    members += 1;
    ticks += Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]);
    const io = readOrNull(`/proc/${entry.name}/io`);
    if (io !== null) bytesMoved = (bytesMoved ?? 0) + Number(io.match(/^rchar:\s*(\d+)/m)?.[1] ?? 0) + Number(io.match(/^wchar:\s*(\d+)/m)?.[1] ?? 0);
  }
  return members === 0 ? null : { bytesMoved, cpuSeconds: ticks / CLOCK_TICKS_PER_SECOND };
}

/** A process can exit between the listing and the read; that is not an error here. */
function readOrNull(path: string): string | null {
  try {
    return readTextFileSync(path);
  } catch {
    return null;
  }
}
