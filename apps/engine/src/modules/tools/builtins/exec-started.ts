/**
 * What `exec` tells the agent when a job has started, and whether its turn goes on.
 *
 * Three answers, and the difference between them is the turn: a service is meant to be used straight
 * away, a job started with `keep_working` leaves the agent free for work that does not need it, and an
 * ordinary job ends the turn so the agent waits to be woken with the result.
 */

import type { ToolResult } from "@nouride/shared";
import { duration } from "@/modules/jobs/wake-text.ts";

export interface StartedJob {
  /** `limitMs`: when the daemon stops it if it is still running — `[security] job_max_ms`. Absent or 0, never. */
  job: { id: string; logPath: string; limitMs?: number };
  argv: string[];
  cwd: string;
  service: boolean;
  keepWorking: boolean;
  /** Asked for with `background: true`, rather than chosen because the command is obviously slow. */
  requested: boolean;
  /** In a turn another agent asked for (`ToolContext.askedBy`): that agent, which its end is reported to. */
  reportsTo?: string;
}

/**
 * What an agent another one asked is told of a job it starts: its end goes to the agent that asked, never to this one
 * (`job-wakes.ts` `reportsTo`). Told it would be woken, an asked agent handed back "I'll follow up when it finishes", and
 * the result reached the agent that asked it instead (0.8.7).
 */
function reportsToAsker(asker: string): string {
  return `You are answering ${asker}, which asked you: a background job's end is reported to ${asker}, not to you, and you are not woken when it finishes. Say in your answer that it is running, with its id, and that ${asker} gets its result. Do not promise to follow up.`;
}

export function jobStarted({ job, argv, cwd, service, keepWorking, requested, reportsTo }: StartedJob): ToolResult {
  if (service) {
    return {
      content:
        `Started as a service, ${job.id}: it keeps running until it is stopped, and your turn goes on.\n` +
        `Live log: ${job.logPath}\n` +
        `Check it answers before you use it. Stop it with \`nouride jobs kill ${job.id}\` when the person is done, and tell them it is running.` +
        /**
         * Over ssh the server lives exactly as long as this connection, and that surprised everyone on a
         * live box: the agent held a Windows server open through a job, killed the job to "free the
         * session", and the person asked why it was running as a job at all instead of from its own
         * start script.
         */
        (/\bssh\b/.test(argv.join(" "))
          ? `\nIt runs on the other machine only while this ssh connection lasts. To keep it running there, start it detached on that machine instead (its own start script through Start-Process or start /b, nohup, or a service) and stop this job.`
          : ``),
      isError: false,
      metadata: { job: job.id, argv, cwd, background: true, service: true },
    };
  }
  const startedBy = requested ? "requested" : "chosen automatically for this long-running command";
  /**
   * Said here, when it applies, and not in the prompt: the limit is the install's and is often off, and this is the
   * one reply the agent reads as it starts the job — the moment to pick `service: true` or smaller steps instead.
   */
  const limit = job.limitMs
    ? `\nIf it is still running after ${duration(job.limitMs)}, the daemon stops it (this install's \`job_max_ms\`) and you are told it did not finish.`
    : ``;
  /**
   * The turn goes on, for work that does not need this job — the agent's call, written into the
   * parameter: an agent that runs a build and then has to deploy it waits, one that also has an
   * unrelated file to fix fixes it meanwhile. Nothing new carries the result: the wake-up waits until
   * the agent is free in this chat (`JobWakes`), so it arrives after this turn either way.
   *
   * "You have not seen its result" is there because, told only to say the job was running, an agent
   * on the live box wrote "Update — the job finished, output: build-selesai" in the same reply, while
   * the job still had seconds to go — and the real wake-up then found the outcome "already reported".
   */
  if (keepWorking) {
    return {
      content:
        `Started in the background as ${job.id} (${startedBy}).\n` +
        `Live log: ${job.logPath}\n` +
        `Your turn goes on: do the other work that does not need it. You have not seen its result, so ` +
        `do not write what it printed or whether it worked: say it is still running. ` +
        (reportsTo ? reportsToAsker(reportsTo) : `The result comes to you as a new message after this turn, and you report it then. Do not wait or poll for it.`) +
        limit,
      isError: false,
      metadata: { job: job.id, argv, cwd, background: true, keepWorking: true },
    };
  }
  return {
    // The id and the log path, because those are the two things the agent can act on before it is
    // woken: report the id to the person, and read the log if they ask sooner.
    content:
      `Started in the background as ${job.id} (${startedBy}).\n` +
      `Live log: ${job.logPath}\n` +
      (reportsTo
        ? reportsToAsker(reportsTo)
        : // Here rather than in the schema, which is at its budget — and here is when it applies.
          `If it prints nothing for a while you will be woken to say it is still running. A command that ` +
          `prints its progress lets you tell a working job from a stuck one; one that holds its output ` +
          `until the end cannot.`) +
      limit,
    isError: false,
    metadata: {
      job: job.id,
      argv,
      cwd,
      background: true,
      control: { finishTurn: "wrap_up", note: "background_started" },
      ...(requested ? {} : { autoBackground: true }),
    },
  };
}
