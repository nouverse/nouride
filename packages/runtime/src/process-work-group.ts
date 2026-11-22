/**
 * A cgroup of its own for what one piece of work starts through a program the daemon does not run command by command,
 * and what that work left running when it ended.
 *
 * A command the daemon runs leads a process group, and what it left there is read as it ends (`process-left.ts`). A
 * coding CLI runs its commands from a shell of its own: the daemon never holds one, and what such a command started and
 * did not wait for is reparented to init the moment its shell exits, in a session whose leader is gone. Its parents no
 * longer lead back to anything, and its session's number was never the daemon's to know. Measured on a live box: a
 * `tail … &` a Claude Code command left survived the command, the session's close and the conversation's delete, with
 * nothing on record to say whose it was.
 *
 * A cgroup is the one thing such a process cannot leave behind: it is inherited at every fork, and neither a new
 * session nor a second fork changes it. So the process that serves the work's session is moved into a cgroup under the
 * commands' own (`process-cgroup.ts`), everything it starts is born there, and at the work's end what is still there
 * is what the work left. The daemon may make the group, move another user's process into it and read it, as the owner
 * of a delegated cgroup; it holds no controller, so the commands' one memory cap still counts all of it.
 *
 * Only where the commands have a cgroup: a systemd unit that hands its own over. Anywhere else nothing is followed and
 * nothing is ended, as before.
 */

import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LeftProcess, LeftRunning } from "@nouride/shared";
import { listDir } from "./fs.ts";
import { commandsCgroup } from "./process-cgroup.ts";

/** A process as the sorting below reads it. */
export interface GroupProcess extends LeftProcess {
  parent: number;
  /** Its process group, and its session. */
  group: number;
  session: number;
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** A process's facts from `/proc/<pid>/stat`, a zombie left out: it holds nothing and ends nothing. */
function factsOf(pid: number, proc: string): GroupProcess | null {
  const stat = read(`${proc}/${pid}/stat`);
  if (!stat) return null;
  // `comm` sits in parentheses and may hold spaces or parentheses itself: count from the last `)`. What follows is
  // state, ppid, pgrp, session, … with the start time at 19 (the file's 22nd field).
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  if (fields[0] === "Z") return null;
  return { pid, name: stat.slice(stat.indexOf("(") + 1, close), parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), started: fields[19] ?? "" };
}

/**
 * The cgroup `name` under the commands' own, made if it is not there. Null where the commands have none, or it could
 * not be made: the work is then not followed.
 */
export function workGroup(name: string): string | null {
  const commands = commandsCgroup();
  if (!commands || !/^[A-Za-z0-9_-]{1,96}$/.test(name)) return null;
  const dir = `${commands}/${name}`;
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

/** Move a process, and with it everything it starts from now on, into a work group. False where the kernel refused. */
export function joinWorkGroup(dir: string, pid: number): boolean {
  try {
    // Appended, as the shell's `echo … >>`: a cgroup file takes each write as one move.
    writeFileSync(`${dir}/cgroup.procs`, `${pid}\n`, { flag: "a" });
    return true;
  } catch {
    return false;
  }
}

/** The processes in a work group now. */
export function workGroupProcesses(dir: string, proc = "/proc"): GroupProcess[] {
  return (read(`${dir}/cgroup.procs`) ?? "")
    .split("\n")
    .filter((line) => /^\d+$/.test(line.trim()))
    .flatMap((line) => factsOf(Number(line), proc) ?? []);
}

/**
 * Done with a work group: what is still in it goes back to the commands' cgroup, where it was before, and the group is
 * removed. False where it could not be removed, something still in it: it is then left, empty of anything followed.
 */
export function closeWorkGroup(dir: string): boolean {
  for (const line of (read(`${dir}/cgroup.procs`) ?? "").split("\n")) {
    if (/^\d+$/.test(line.trim())) joinWorkGroup(dirname(dir), Number(line));
  }
  try {
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** A process's children now, by `/proc`. None where it cannot be read. */
export function childrenOf(pid: number, proc = "/proc"): number[] {
  if (!Number.isInteger(pid) || pid <= 1) return [];
  const children: number[] = [];
  for (const entry of listDir(proc)) {
    if (!/^\d+$/.test(entry.name)) continue;
    const facts = factsOf(Number(entry.name), proc);
    if (facts?.parent === pid) children.push(facts.pid);
  }
  return children;
}

/** What a work group holds at its work's end, sorted: see `sortLeft`. */
export interface LeftInGroup {
  /** What the work's commands left in their own groups: ended with the work, as a daemon command's is. */
  left: LeftRunning[];
  /** What set itself apart, in a session of its own making: left running, and said. */
  apart: LeftProcess[];
  /** What the program serving the work still holds: the work's session not closed yet, or a command of its own still running. */
  held: LeftProcess[];
  /** What could be told from neither: in a group it shares with something else. Left, and logged. */
  unsure: LeftProcess[];
}

/**
 * Sort what a work group holds (pure).
 *
 * `roots` are the processes that serve the work, the ones moved in. What descends from one still running is held by it:
 * a command at work, a background shell the program itself will end. So is anything in a session one of those leads,
 * whose own parent has gone: it is still that running command's.
 *
 * Of the rest, nothing holds them. One that leads a session of its own, or sits in a session whose leader is such a
 * process, set itself apart on purpose, as a build daemon or a process manager does, and is left: the rule a command
 * of the daemon's has (`process-left.ts`). What remains is in a session whose leader is gone, a command's shell that
 * ended: what the command started and did not wait for. It is given by process group, the unit a signal reaches, and
 * only a group every member of which is here: `inGroup` says who is in a group on the whole machine, and a group
 * shared with anything else is never signalled.
 */
export function sortLeft(processes: readonly GroupProcess[], roots: readonly Pick<LeftProcess, "pid" | "started">[], inGroup: (group: number) => readonly Pick<LeftProcess, "pid">[]): LeftInGroup {
  const byPid = new Map(processes.map((one) => [one.pid, one]));
  const held = new Set<number>();
  for (const root of roots) {
    const there = byPid.get(root.pid);
    // The same process and not a later one of its number: its start time tells them apart.
    if (there && there.started === root.started) held.add(there.pid);
  }
  // Parents first is not given, so until nothing changes: a list of a few dozen at most.
  for (let grew = true; grew; ) {
    grew = false;
    for (const one of processes) {
      if (held.has(one.pid)) continue;
      if (held.has(one.parent) || (one.session !== one.pid && held.has(one.session))) {
        held.add(one.pid);
        grew = true;
      }
    }
  }
  const free = processes.filter((one) => !held.has(one.pid));
  const leads = new Set(free.filter((one) => one.session === one.pid).map((one) => one.pid));
  const apart = free.filter((one) => leads.has(one.session));
  const orphans = free.filter((one) => !leads.has(one.session));
  const left: LeftRunning[] = [];
  const unsure: LeftProcess[] = [];
  for (const group of new Set(orphans.map((one) => one.group))) {
    const members = orphans.filter((one) => one.group === group);
    const mine = new Set(members.map((one) => one.pid));
    const whole = inGroup(group).every((one) => mine.has(one.pid));
    if (whole && group > 1) left.push({ group, members: members.map(plain) });
    else unsure.push(...members.map(plain));
  }
  return { left, apart: apart.map(plain), held: processes.filter((one) => held.has(one.pid)).map(plain), unsure };
}

const plain = (one: GroupProcess): LeftProcess => ({ pid: one.pid, started: one.started, name: one.name });
