/**
 * A command that outlives the call that started it.
 *
 * The gap this closes is the biggest one between this runtime and Claude Code, and it is a *shape*
 * rather than a tool: nothing in Nouride could previously survive a single turn. Every `exec` blocked
 * until it finished, capped at 300s — the same as `max_turn_duration_ms`, so a five-minute command
 * could never even use its own budget before the turn killed it.
 *
 * On a server that rules out most of what is worth doing: a test suite, a build, `docker compose up`,
 * tailing a log for an error. All of them take longer than a turn.
 *
 * Output goes to **files**, not memory. A build log is megabytes, and holding it in RAM until someone
 * asks would mean one runaway command can exhaust the daemon — while a file is something the agent can
 * `read` with an offset like any other.
 */

import { constants } from "node:os";
import type { SandboxOptions } from "@nouride/shared";
import { commandLine, withOomKills } from "./process.ts";
import { trackCommand, untrackCommand } from "./process-agents.ts";
import { commandsOomKills } from "./process-cgroup.ts";
import { ownGroupSpawnOptions, signalTree } from "./process-group.ts";

/**
 * How long a job is given to stop on SIGTERM before the group is killed outright.
 *
 * Long enough for a dev server or a compose stack to shut down cleanly, short enough that a shutdown
 * waiting on a job that ignores SIGTERM is still well inside the unit's stop timeout.
 */
const STOP_GRACE_MS = 5_000;

export interface BackgroundHandle {
  pid: number;
  /**
   * Resolves when the process exits. Rejects only if the spawn itself failed. `oomKills`: processes the kernel stopped
   * for memory among the agents' commands while it ran — what its own exit may not show (`SandboxResult.oomKills`).
   */
  exited: Promise<{ exitCode: number | null; signal: string | null; oomKills?: number }>;
  /** One signal to the job — to its whole process group, where it leads one. */
  kill(signal?: NodeJS.Signals): void;
  /**
   * SIGTERM to the group, then SIGKILL to whatever is still there after `graceMs`.
   *
   * Resolves once the job has exited, or once the SIGKILL has gone out. One SIGTERM to the direct child
   * was the whole of it before, so `sh -c "npm run dev"` lost `sh` and kept `node`: the pipes stayed
   * open, the pump never saw EOF, and the row said `running` for as long as the daemon lived.
   */
  stop(graceMs?: number): Promise<void>;
}

export interface BackgroundOptions {
  cwd: string;
  env: Record<string, string>;
  /** Absolute path for stdout+stderr, interleaved as a terminal would show them. */
  logPath: string;
  /** The kernel's ceilings, as a foreground command gets them (`withLimits`). None when absent. */
  limits?: SandboxOptions["limits"];
  /** The agent whose job this is: run as its own user where boot found the helper (`process-agents.ts`). */
  agent?: string;
  /**
   * What the log is written through — a new one per stream, given its text as it arrives. The engine masks the job's
   * credentials with it (S5): the file is readable by the agent, so a value has to be gone before it is written,
   * not when the log is read back. Without one, the bytes go to the file as they came.
   */
  filter?: () => TextFilter;
}

/** Text in, what may be written out — holding back what the next piece decides, released by `end`. */
export interface TextFilter {
  push(text: string): string;
  end(): string;
}

export function startBackgroundCommand(
  cmd: string[],
  opts: BackgroundOptions,
): BackgroundHandle {
  if (cmd.length === 0) throw new Error("startBackgroundCommand: empty command");

  const log = Bun.file(opts.logPath).writer();
  const oomBefore = commandsOomKills();

  const line = commandLine(cmd, opts);
  const proc = Bun.spawn({
    // Niced like the foreground path, and this one matters more: `exec` auto-backgrounds anything
    // long-running, so a build or a test suite arrives *here*. Wrapping only the foreground path
    // would have slowed the two-second commands and left the twenty-minute ones at full priority,
    // which is exactly backwards.
    //
    // In a group of its own for the same reason, and the outermost wrapper for the same reason it is
    // there: what the job starts has to be reachable by the signal that stops it.
    //
    // Under the same ceilings as the foreground, when the operator set them (S5): a job runs unwatched for as long
    // as it likes, which makes an allocation that never stops worse here, not better.
    cmd: line.cmd,
    ...ownGroupSpawnOptions(),
    cwd: opts.cwd,
    env: opts.env,
    // `ignore`, not `inherit`: a background child must never be able to read the daemon's stdin, and
    // inheriting it would let an interactive command block forever waiting for input nobody will send.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  trackCommand(proc.pid, line.pidFile);

  // Interleaved into one file rather than two. The ordering a person expects from a terminal is the
  // ordering that makes a failure readable — stderr split into its own file loses which command it
  // came after.
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const filter = opts.filter?.();
    // One decoder per stream, so a character split between two reads is joined rather than mangled.
    const decoder = filter ? new TextDecoder() : null;
    const write = (piece: Uint8Array | string) => {
      if (piece.length === 0) return;
      log.write(piece);
      log.flush();
    };
    for await (const chunk of stream) write(filter && decoder ? filter.push(decoder.decode(chunk, { stream: true })) : chunk);
    if (filter && decoder) write(filter.push(decoder.decode()) + filter.end());
  };

  const exited = (async () => {
    await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    const exitCode = await proc.exited;
    await log.end();
    untrackCommand(proc.pid);
    return { exitCode, signal: signalName(proc.signalCode), ...withOomKills(oomBefore) };
  })();

  const stop = async (graceMs = STOP_GRACE_MS): Promise<void> => {
    signalTree(proc, "SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<"grace">((resolve) => {
      timer = setTimeout(() => resolve("grace"), graceMs);
    });
    // `exited` waits for the pipes as well as the process, so a grandchild still holding them open
    // reads as still running — which is the case the SIGKILL is for.
    const first = await Promise.race([exited.then(() => "exited" as const, () => "exited" as const), graceOver]);
    clearTimeout(timer);
    if (first === "grace") signalTree(proc, "SIGKILL");
  };

  return {
    pid: proc.pid,
    exited,
    kill: (signal = "SIGTERM") => signalTree(proc, signal),
    stop,
  };
}

/**
 * The signal that ended a process, by name — what `exited` promises and what a job's stop reason is read from. Bun gives
 * a name; its types say a number may come instead (1.4.4), and a number is named from this platform's table.
 */
function signalName(code: NodeJS.Signals | number | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  if (typeof code === "string") return code;
  return Object.entries(constants.signals).find(([, number]) => number === code)?.[0] ?? String(code);
}
