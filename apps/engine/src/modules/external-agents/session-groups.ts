/**
 * What a coding CLI's session started and left running, for the work that session was: a mission's.
 *
 * A mission's own commands lead groups the daemon holds, and what they left is ended with the mission
 * (`missions/left-running.ts`). An agent on a coding CLI runs its commands from the CLI's shell: the daemon holds none
 * of them. What one started and did not wait for outlives the command, the session's close and the conversation, in a
 * session whose leader is gone, with nothing to say whose it was. The backlog's case was a build's Gradle and Kotlin
 * daemons, found by the install gate a day later.
 *
 * So the process that serves a followed session is put in a cgroup of the work's own as the session opens
 * (`@nouride/runtime` `process-work-group.ts`), everything it starts is born there, and at the work's end what is
 * still there is sorted: a command's leftovers, given by group to be ended as a daemon command's are; what set itself
 * apart, left and named; what the CLI still holds, left to it.
 *
 * Only for a CLI that serves a session from a process of its own, and only where the commands have a cgroup. A CLI
 * that serves every session from one process is not followed: nothing there is one session's. Kept in memory: a
 * restart ends the commands' cgroup and everything in it.
 */

import { createLogger, type LeftProcess, type LeftRunning } from "@nouride/shared";
import { childrenOf, closeWorkGroup, commandGroupOf, groupMembers, joinWorkGroup, sortLeft, workGroup, workGroupProcesses, type GroupProcess, type LeftInGroup } from "@nouride/runtime";
import type { ChildrenOf } from "./connection.ts";

const log = createLogger("external-agents.left");

/** How long a session's process is given to end once its session was let go, before what is there is sorted anyway. */
export const SESSION_GONE_MS = 8_000;
/** How often that is looked at. */
const LOOK_MS = 200;
/**
 * How long after it ended what it kept running is given to end with it: a CLI ends its own background shells as its
 * session closes, and on a live box they were gone within three seconds. Sorted sooner, a shell on its way out read
 * as something that had set itself apart.
 */
export const SETTLE_MS = 3_000;

/** The machine as this reads and changes it: the runtime's, or a test's. */
export interface GroupOs {
  make(name: string): string | null;
  join(dir: string, pid: number): boolean;
  processes(dir: string): GroupProcess[];
  close(dir: string): boolean;
  sort(processes: readonly GroupProcess[], roots: readonly Pick<LeftProcess, "pid" | "started">[]): LeftInGroup;
  wait(ms: number): Promise<void>;
}

/** The machine itself, by the runtime. */
export const MACHINE_GROUPS: GroupOs = {
  make: workGroup,
  join: joinWorkGroup,
  processes: workGroupProcesses,
  close: closeWorkGroup,
  sort: (processes, roots) => sortLeft(processes, roots, groupMembers),
  wait: (ms) => new Promise((done) => setTimeout(done, ms)),
};

/** A CLI's children, by the pid the daemon holds: the CLI's own behind the client's, where agents run as their own users. */
export const ownChildren: ChildrenOf = (pid) => childrenOf(commandGroupOf(pid));

/** What a session's work left: what is to be ended, and what set itself apart and stays. */
export interface SessionLeft {
  left: LeftRunning[];
  apart: LeftProcess[];
}

export class SessionGroups {
  /** Each followed conversation's group and the processes moved into it, by `agent|conversation`. */
  private readonly groups = new Map<string, { dir: string; roots: Pick<LeftProcess, "pid" | "started">[] }>();

  constructor(private readonly os: GroupOs) {}

  /**
   * A session opened for a followed conversation, with the processes the CLI started for it, or null where that could
   * not be told. Each is moved into the work's group, made at its first; a later session of the same work, opened after
   * a failed turn or a restart of the CLI, joins the same group.
   */
  follow(key: string, name: string, born: readonly number[] | null): void {
    if (born === null) {
      log.info("a session opened beside another: which process serves it cannot be told, and what its commands leave is not followed", { session: key });
      return;
    }
    if (born.length === 0) return;
    const dir = this.groups.get(key)?.dir ?? this.os.make(name);
    if (!dir) return;
    const kept = this.groups.get(key) ?? { dir, roots: [] };
    const moved = born.filter((pid) => this.os.join(dir, pid));
    const there = new Map(this.os.processes(dir).map((one) => [one.pid, one]));
    for (const pid of moved) {
      const one = there.get(pid);
      // One that ended in between, a check the CLI ran as it started, is nobody to follow.
      if (one) kept.roots.push({ pid, started: one.started });
    }
    this.groups.set(key, kept);
    log.info("following what a session's commands start", { session: key, group: name, processes: moved.length });
  }

  /** Whether a conversation's session is followed: what `left` then answers for. */
  followed(key: string): boolean {
    return this.groups.has(key);
  }

  /**
   * The work is over and its session let go: what it left. Waits for the session's process to end, and for what that
   * kept to end with it, then sorts what is still in the group and lets the group go. Null where nothing was followed.
   * Never throws.
   */
  async left(key: string): Promise<SessionLeft | null> {
    const kept = this.groups.get(key);
    if (!kept) return null;
    this.groups.delete(key);
    try {
      const serving = () => {
        const there = this.os.processes(kept.dir);
        return kept.roots.some((root) => there.some((one) => one.pid === root.pid && one.started === root.started));
      };
      for (let waited = 0; waited < SESSION_GONE_MS && serving(); waited += LOOK_MS) await this.os.wait(LOOK_MS);
      if (serving()) log.info("a session's process is still there after its session was let go; what it holds is left to it", { session: key });
      else await this.os.wait(SETTLE_MS);
      const sorted = this.os.sort(this.os.processes(kept.dir), kept.roots);
      if (sorted.unsure.length > 0) log.info("left running by a session and not ended: in a group shared with something else", { session: key, processes: sorted.unsure.map((one) => one.name) });
      return { left: sorted.left, apart: sorted.apart };
    } catch (err) {
      log.warn("what a session left running could not be read", { session: key, error: String(err) });
      return null;
    } finally {
      // What is still in it goes back where it was; the group itself is no longer anybody's.
      this.os.close(kept.dir);
    }
  }
}
