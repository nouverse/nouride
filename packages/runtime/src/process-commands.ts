/**
 * The commands a long-lived process started that still run, read from `/proc`.
 *
 * Exists for one decision: whether an external agent's coding CLI with no prompt running is idle. Claude Code runs a
 * command left "in the background" in a shell that leads a session of its own, under its own process, and it goes on
 * after the prompt that started it has ended (measured on the box, 2026-10-28: `claude` → `bash` with its own sid →
 * `sleep`). The idle sweep stopped the CLI five minutes after its last prompt, and the command with it. A process the
 * CLI runs in its own session is not counted.
 *
 * Linux only. Zero elsewhere, or where nothing can be read — the caller then goes by the time alone, as before.
 */

import { listDir, readTextFileSync } from "./fs.ts";
import { commandGroupOf } from "./process-agents.ts";

/** How far up a command's parents are followed to the process: a shell, a wrapper, the command — never this many. */
const MAX_DEPTH = 32;

/** How many processes under `pid` lead a session of their own: the commands it started, still running. */
export function commandsRunningUnder(pid: number): number {
  if (process.platform !== "linux") return 0;
  // The command itself where the daemon holds a client for it (`process-agents.ts`): it leads its own group.
  const root = commandGroupOf(pid);
  const parents = new Map<number, number>();
  const leaders: number[] = [];
  for (const entry of listDir("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    const stat = readOrNull(`/proc/${entry.name}/stat`);
    if (!stat) continue;
    // `comm` sits in parentheses and may hold spaces or parentheses itself: count from the last `)`.
    // What follows is state, ppid, pgrp, session, …
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // A command that ended and was not reaped yet is not running: a zombie, `Z`.
    if (fields[0] === "Z") continue;
    const own = Number(entry.name);
    parents.set(own, Number(fields[1]));
    if (Number(fields[3]) === own && own !== root) leaders.push(own);
  }
  let running = 0;
  for (const leader of leaders) {
    let at = parents.get(leader);
    for (let depth = 0; at !== undefined && at > 1 && depth < MAX_DEPTH; depth += 1) {
      if (at === root) {
        running += 1;
        break;
      }
      at = parents.get(at);
    }
  }
  return running;
}

/** A process can exit between the listing and the read; that is not an error here. */
function readOrNull(path: string): string | null {
  try {
    return readTextFileSync(path);
  } catch {
    return null;
  }
}
