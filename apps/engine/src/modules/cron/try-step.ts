/**
 * A command tried alone, from a step's panel: run once, for real, and what it printed handed back to the page.
 *
 * A person who does not read code agrees to a script by what it is said to do. Seeing it run, on an input they can
 * read, is the other half: what it printed, or why it failed, before the automation is saved or turned on. It is a
 * real run of that command: a script that posts, posts, and the page says so.
 *
 * It is no run of the automation. Nothing is written to its history, its schedule does not move, nothing is sent to
 * the chat it reports to, and a step marked to go on only when its words changed is not compared with anything.
 */

import type { CommandRuns, CronSection } from "@nouride/shared";
import { runJobCommand } from "./job-command.ts";
import type { CronExecutors } from "./scheduler.ts";

/**
 * The longest a try is waited for, whatever the step's own limit. A request held open longer is cut by a proxy on
 * the way, and the page would read a script still at work as one that failed: longer work is tried with Run now,
 * whose runs are kept.
 */
export const TRY_MAX_MS = 60_000;

/** How long a try may take: the step's own limit, or the daemon's for a command, and never past `TRY_MAX_MS`. */
export function tryLimit(stepMs: number | undefined, daemonMs: number): number {
  return Math.min(stepMs ?? daemonMs, TRY_MAX_MS);
}

/** How much of what it printed goes back to the page. */
const SAID_MAX = 8_000;

/** How a try went: what a step's outcome is called, with what it printed or why it failed. */
export interface Tried {
  status: "done" | "empty" | "failed";
  said: string;
  ms: number;
}

export async function tryCommand(
  /** `held`: the install was imported and has not gone live, so nothing runs here yet (`CronSchedulerOptions.held`). */
  executors: Pick<CronExecutors, "commandSandbox" | "asleep"> & { held?: () => boolean },
  config: Pick<CronSection, "commandTimeoutMs">,
  agentId: string,
  command: CommandRuns,
  /** On its standard input: what the step before would have said, or a webhook's body, as the page gives it. */
  input: string | undefined,
  now: () => number = Date.now,
): Promise<Tried> {
  if (executors.held?.()) return { status: "failed", said: "this install was imported and has not gone live: nothing runs here until Go live", ms: 0 };
  // Asleep, it takes no work: a try is work.
  if (executors.asleep?.(agentId)) return { status: "failed", said: `${agentId} is asleep and runs nothing until a person wakes it`, ms: 0 };
  const began = now();
  const ran = await runJobCommand(executors, config, { agentId }, { ...command, timeoutMs: tryLimit(command.timeoutMs, config.commandTimeoutMs) }, input);
  const ms = now() - began;
  if ("error" in ran) return { status: "failed", said: ran.error.slice(0, SAID_MAX), ms };
  const said = ran.output.trim();
  return said ? { status: "done", said: said.slice(0, SAID_MAX), ms } : { status: "empty", said: "", ms };
}
