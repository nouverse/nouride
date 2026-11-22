/**
 * A cgroup for what one piece of work starts, and what it left there (`process-work-group.ts`).
 *
 * Against a cgroup filesystem and a `/proc` of plain files in a temp directory, as `process-cgroup.test.ts` has its
 * own: what is decided, which processes are a command's leftovers, which set themselves apart and which are still
 * held, is read from the files. That the kernel lets the daemon's user move another user's process into a group of its
 * own, and that a process cannot leave one by a new session, was shown on a live box, not here.
 *
 * The processes are the ones measured there: a coding CLI's session process, the shells it leads its commands in,
 * what a command left when its shell ended, and what set itself apart.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetCommandIsolation, isolateCommands } from "../src/process-cgroup.ts";
import { childrenOf, closeWorkGroup, joinWorkGroup, sortLeft, workGroup, workGroupProcesses, type GroupProcess } from "../src/process-work-group.ts";

const made: string[] = [];
afterEach(() => {
  forgetCommandIsolation();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A unit's cgroup handed over and split, and where its commands' cgroup is. */
function split(): string {
  const root = mkdtempSync(join(tmpdir(), "nouride-work-group-"));
  made.push(root);
  const cgroup = join(root, "system.slice/nouride.service");
  mkdirSync(cgroup, { recursive: true });
  for (const [name, text] of Object.entries({ "cgroup.controllers": "cpu memory pids\n", "cgroup.subtree_control": "", "cgroup.procs": "4242\n", "memory.high": "1717986918\n", "memory.max": "max\n", "pids.max": "76278\n" })) writeFileSync(join(cgroup, name), text);
  writeFileSync(join(root, "self"), "0::/system.slice/nouride.service\n");
  writeFileSync(join(root, "meminfo"), "MemTotal:        2097152 kB\n");
  const said = isolateCommands({ env: { NOURIDE_SERVICE_KIND: "systemd", NOURIDE_CGROUP: "delegated" }, root, self: join(root, "self"), meminfo: join(root, "meminfo") });
  expect(said.isolated).toBe(true);
  return join(cgroup, "commands");
}

/** A `/proc` of plain files: each process's `stat`, as the kernel writes one. */
function procOf(processes: { pid: number; name: string; parent: number; group: number; session: number; started?: string; state?: string }[]): string {
  const proc = mkdtempSync(join(tmpdir(), "nouride-proc-"));
  made.push(proc);
  for (const one of processes) {
    mkdirSync(join(proc, String(one.pid)));
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime …
    writeFileSync(join(proc, String(one.pid), "stat"), `${one.pid} (${one.name}) ${one.state ?? "S"} ${one.parent} ${one.group} ${one.session} 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 ${one.started ?? `9${one.pid}`} 1 1\n`);
  }
  return proc;
}

const p = (pid: number, name: string, parent: number, group: number, session: number, started = `9${pid}`): GroupProcess => ({ pid, name, parent, group, session, started });
/** Who is in a group on the whole machine: the listed ones, and whoever a test adds from outside. */
const machine = (processes: readonly GroupProcess[], outside: { pid: number; group: number }[] = []) => (group: number) => [...processes, ...outside].filter((one) => one.group === group);

describe("a work group under the commands' cgroup", () => {
  test("made where the commands have a cgroup, and a process moved into it is listed there", () => {
    const commands = split();
    const dir = workGroup("m-msn_1a2b");
    expect(dir).toBe(join(commands, "m-msn_1a2b"));
    expect(existsSync(dir!)).toBe(true);
    // Made once: the same work asks again when its session is opened anew.
    expect(workGroup("m-msn_1a2b")).toBe(dir);
    expect(joinWorkGroup(dir!, 7001)).toBe(true);
    expect(joinWorkGroup(dir!, 7002)).toBe(true);
    const proc = procOf([
      { pid: 7001, name: "claude", parent: 7000, group: 7000, session: 7000 },
      { pid: 7002, name: "node (worker)", parent: 7001, group: 7002, session: 7002, started: "555" },
    ]);
    expect(workGroupProcesses(dir!, proc)).toEqual([
      { pid: 7001, name: "claude", parent: 7000, group: 7000, session: 7000, started: "97001" },
      // A name with a space and a parenthesis of its own is read whole.
      { pid: 7002, name: "node (worker)", parent: 7001, group: 7002, session: 7002, started: "555" },
    ]);
  });

  test("none where the commands have no cgroup: the work is not followed", () => {
    expect(workGroup("m-msn_1a2b")).toBeNull();
  });

  test("a name that is not a plain one is refused: it becomes a directory", () => {
    split();
    for (const name of ["", "../daemon", "a/b", "m msn", "x".repeat(97)]) expect(workGroup(name)).toBeNull();
  });

  test("a process that has ended, or ended and was not reaped, is not listed", () => {
    split();
    const dir = workGroup("m-1")!;
    for (const pid of [7001, 7002, 7003]) joinWorkGroup(dir, pid);
    const proc = procOf([
      { pid: 7001, name: "tail", parent: 1, group: 6990, session: 6990 },
      { pid: 7002, name: "sh", parent: 1, group: 6990, session: 6990, state: "Z" },
    ]);
    expect(workGroupProcesses(dir, proc).map((one) => one.pid)).toEqual([7001]);
  });

  test("closed: what is still in it goes back to the commands' cgroup", () => {
    const commands = split();
    const dir = workGroup("m-1")!;
    joinWorkGroup(dir, 7001);
    joinWorkGroup(dir, 7002);
    // Plain files stand for the kernel's: the directory is not empty here, so it stays; on a cgroup filesystem it goes.
    expect(closeWorkGroup(dir)).toBe(false);
    expect(readFileSync(join(commands, "cgroup.procs"), "utf8")).toBe("7001\n7002\n");
  });

  test("a process's children are the ones whose parent it is", () => {
    const proc = procOf([
      { pid: 7001, name: "MainThread", parent: 7000, group: 7001, session: 7001 },
      { pid: 7010, name: "claude", parent: 7001, group: 7001, session: 7001 },
      { pid: 7011, name: "claude", parent: 7001, group: 7001, session: 7001 },
      { pid: 7020, name: "bash", parent: 7010, group: 7020, session: 7020 },
      { pid: 7030, name: "gone", parent: 7001, group: 7001, session: 7001, state: "Z" },
    ]);
    expect(childrenOf(7001, proc).sort()).toEqual([7010, 7011]);
    expect(childrenOf(7020, proc)).toEqual([]);
    expect(childrenOf(1, proc)).toEqual([]);
  });
});

describe("what a work group holds at its work's end, sorted", () => {
  const claude = p(7010, "claude", 7001, 7001, 7001);

  test("what a command started and did not wait for, its shell gone: left, by its group", () => {
    // Measured on the box: `tail … & echo started`, the shell 7188 ended, the tail reparented to init in its session.
    const tail = p(7189, "tail", 1, 7188, 7188);
    const sorted = sortLeft([tail], [], machine([tail]));
    expect(sorted.left).toEqual([{ group: 7188, members: [{ pid: 7189, started: "97189", name: "tail" }] }]);
    expect(sorted.apart).toEqual([]);
    expect(sorted.unsure).toEqual([]);
  });

  test("what set itself apart, a session of its own making, and what it started: left running, and said", () => {
    const gradle = p(7300, "java", 1, 7300, 7300);
    const kotlin = p(7340, "java", 7300, 7300, 7300);
    const sorted = sortLeft([gradle, kotlin], [], machine([gradle, kotlin]));
    expect(sorted.left).toEqual([]);
    expect(sorted.apart.map((one) => one.pid)).toEqual([7300, 7340]);
  });

  test("while the session's own process runs, what descends from it is its own: a command at work, a shell it keeps", () => {
    const shell = p(7400, "bash", 7010, 7400, 7400);
    const build = p(7401, "node", 7400, 7400, 7400);
    const worker = p(7402, "node", 7401, 7400, 7400);
    const tail = p(7189, "tail", 1, 7188, 7188);
    const all = [claude, shell, build, worker, tail];
    const sorted = sortLeft(all, [{ pid: 7010, started: "97010" }], machine(all));
    expect(sorted.held.map((one) => one.pid)).toEqual([7010, 7400, 7401, 7402]);
    expect(sorted.left.map((one) => one.group)).toEqual([7188]);
  });

  test("a process of a running command whose own parent has gone is still that command's", () => {
    const shell = p(7400, "bash", 7010, 7400, 7400);
    const orphanOfIt = p(7455, "node", 1, 7400, 7400);
    const all = [claude, shell, orphanOfIt];
    expect(sortLeft(all, [{ pid: 7010, started: "97010" }], machine(all)).held.map((one) => one.pid)).toEqual([7010, 7400, 7455]);
  });

  test("the session's process gone, the shells it kept are nobody's: each a leader that is still there is apart, what a dead one led is left", () => {
    // The session closed and its process ended; a background shell not yet ended leads its session still.
    const shell = p(7400, "bash", 1, 7400, 7400);
    const child = p(7401, "sleep", 7400, 7400, 7400);
    const tail = p(7189, "tail", 1, 7188, 7188);
    const all = [shell, child, tail];
    const sorted = sortLeft(all, [{ pid: 7010, started: "97010" }], machine(all));
    expect(sorted.held).toEqual([]);
    expect(sorted.apart.map((one) => one.pid)).toEqual([7400, 7401]);
    expect(sorted.left.map((one) => one.group)).toEqual([7188]);
  });

  test("a number used again is not the process that was moved in: nothing is held by it", () => {
    const later = p(7010, "sh", 1, 7010, 6000, "123456");
    const child = p(7011, "sleep", 7010, 7010, 6000);
    const all = [later, child];
    const sorted = sortLeft(all, [{ pid: 7010, started: "97010" }], machine(all));
    expect(sorted.held).toEqual([]);
    expect(sorted.left.map((one) => one.group)).toEqual([7010]);
  });

  test("a group shared with anything outside is never given to be signalled", () => {
    // What the session's process started in the CLI's own group, an MCP server, and outlived it: the CLI is in that group.
    const server = p(7600, "node", 1, 7001, 7001);
    const sorted = sortLeft([server], [], machine([server], [{ pid: 7001, group: 7001 }]));
    expect(sorted.left).toEqual([]);
    expect(sorted.unsure).toEqual([{ pid: 7600, started: "97600", name: "node" }]);
  });

  test("two commands' leftovers are two groups, each with its own members", () => {
    const a1 = p(7189, "tail", 1, 7188, 7188);
    const a2 = p(7190, "tail", 1, 7188, 7188);
    const b = p(7250, "node", 1, 7249, 7249);
    const all = [a1, a2, b];
    const sorted = sortLeft(all, [], machine(all));
    expect(sorted.left).toEqual([
      { group: 7188, members: [{ pid: 7189, started: "97189", name: "tail" }, { pid: 7190, started: "97190", name: "tail" }] },
      { group: 7249, members: [{ pid: 7250, started: "97250", name: "node" }] },
    ]);
  });

  test("nothing there, nothing sorted", () => {
    expect(sortLeft([], [{ pid: 7010, started: "97010" }], () => [])).toEqual({ left: [], apart: [], held: [], unsure: [] });
  });
});
