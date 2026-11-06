/**
 * An agent's command, run as that agent's own user (0.8.0, `packages/isolation`).
 *
 * Boot finds `nouride-run` — the root helper's socket, or the daemon itself being root on a Box — and hands this module
 * the client's command line to put in front of an agent's command. Nothing else in the spawn path changes: the client
 * is the child the daemon starts, its stdin, stdout, stderr and exit are the command's, and stopping it stops the
 * command. Where boot found no helper, or a command names no agent — the daemon's own `git`, `ffmpeg` — the command
 * runs as the daemon's user, as before.
 *
 * One thing the client cannot pass on: what the command is doing. It runs in a process group of the helper's making,
 * as another user, so the daemon reads it by the command's own pid, which the client writes to a file once the helper
 * says it — `processGroupActivity` looks it up here.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFileSync, removePath } from "./fs.ts";

/** How an agent's command reaches its user, from boot (`@nouride/isolation`). */
export interface AgentCommands {
  /** The client's command line for `agent`, run in `cwd`, writing the command's pid to `pidFile`. */
  prefix(agent: string, cwd: string | undefined, pidFile: string): string[];
  /** The command line that writes its stdin to `path` as `agent` (`writeFileAsAgent`). */
  put(agent: string, path: string): string[];
}

let through: AgentCommands | null = null;
/** Each running client's pid file, by the client's pid — the pid the daemon holds. */
const pidFiles = new Map<number, string>();
let made = 0;

/** Run agents' commands through the helper from now on — or, with null, as the daemon's user again. */
export function runAgentCommandsThrough(commands: AgentCommands | null): void {
  through = commands;
}

/** Whether agents' commands run as their own users. */
export function agentCommandsHaveOwnUsers(): boolean {
  return through !== null;
}

/**
 * The mode of a file the daemon writes for an agent's commands to read — a job's log, an attachment, a tool's long
 * output. `0640` where each agent is its own user: the folder it is written in is the agent's group's (the helper
 * makes it so), and the file takes that group. `0600` otherwise, the daemon's alone, as it always was.
 */
export function agentReadableMode(): number {
  return through ? 0o640 : 0o600;
}

/** The command line that writes a file as `agent`; null where agents' commands run as the daemon's user. */
export function putAsAgent(agent: string, path: string): string[] | null {
  return through ? through.put(agent, path) : null;
}

/**
 * `cmd` as `agent` runs it: behind the client where boot found the helper, unchanged otherwise. The pid file, when
 * there is one, is the caller's to `trackCommand` once it has the client's pid.
 */
export function asItsAgent(cmd: string[], agent: string | undefined, cwd: string | undefined): { cmd: string[]; pidFile?: string } {
  if (!through || !agent) return { cmd };
  made += 1;
  const pidFile = join(tmpdir(), `nouride-command-${process.pid}-${made}.pid`);
  return { cmd: [...through.prefix(agent, cwd, pidFile), ...cmd], pidFile };
}

/** The client `clientPid` writes its command's pid to `pidFile`. Forgotten, and the file removed, by `untrackCommand`. */
export function trackCommand(clientPid: number, pidFile: string | undefined): void {
  if (pidFile) pidFiles.set(clientPid, pidFile);
}

export function untrackCommand(clientPid: number): void {
  const file = pidFiles.get(clientPid);
  if (!file) return;
  pidFiles.delete(clientPid);
  removePath(file);
}

/** The process group a pid the daemon holds stands for: the command's, where it runs as its agent and has started. */
export function commandGroupOf(pid: number): number {
  const file = pidFiles.get(pid);
  if (!file) return pid;
  try {
    const own = Number(readTextFileSync(file).trim());
    return Number.isInteger(own) && own > 0 ? own : pid;
  } catch {
    return pid;
  }
}
