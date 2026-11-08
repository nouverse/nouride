/**
 * The order in which a daemon replaces itself.
 *
 * Three steps, and the ordering is the whole safety property:
 *
 * 1. **Schedule the follow-up turn.** Before anything is touched. A restart ends the
 *    conversation that asked for it, and an update that goes wrong is discovered by
 *    whoever comes back — so the turn that comes back has to exist while the daemon still
 *    works. `cli/wake-up.ts` learned this for `nouride restart`: a wake-up that depends on
 *    something happening *after* the restart is a wake-up that is missing on the run that
 *    needed it, which is the run where the daemon did not come back.
 * 2. **Swap the files.** Verified, atomic, with the previous version kept beside them.
 * 3. **End the process**, so the supervisor starts the new binary.
 *
 * If step 2 fails, step 1 has left a turn that will arrive and say the version did not
 * change — which is the right outcome, and better than a silent failure. If step 3's
 * restart never brings the daemon back, the job is still in the table and fires whenever
 * something does.
 */

import { clip, contained, createLogger } from "@nouride/shared";
import type { CronPort } from "@/modules/cron/cron.store.ts";
import type { JobsPort } from "@/modules/jobs/jobs.store.ts";
import type { UpdateToolOptions } from "@/modules/tools/builtins/update.ts";
import { applyUpdate as applyPluginUpdate, checkForUpdate, installDownloaded, updateSupported } from "@/modules/update/index.ts";

const log = createLogger("update.self");

export interface SelfUpdateDeps {
  dataDir: string;
  cron: CronPort;
  /** Ends the process so the supervisor starts the new binary. Same hook `POST /restart` uses. */
  requestRestart: (reason: string) => void;
  /** True when a finished download is already staged and only the install is left. */
  staged?: boolean;
  /**
   * Whether a turn is running or waiting, or a job is working in the background. Given, the restart waits for
   * idle — up to `IDLE_WAIT_MS` — so an update never cuts a turn or a job in half; absent, or with
   * `immediately`, it restarts now.
   */
  busy?: () => boolean;
  /** Restart now, whatever is running — `nouride update --start --now`. */
  immediately?: boolean;
  /** Background jobs at work — waited for however long they take, where `busy` gives up at ten minutes. */
  jobs?: () => WorkingJob[];
  pacing?: RestartPacing;
}

/** How soon a waiting restart first looks and how often it looks again — `restartWhenIdle`'s defaults when absent. */
export interface RestartPacing {
  beatMs?: number;
  pollMs?: number;
}

/**
 * The longest an update waits for the daemon to go idle before restarting anyway. A turn cut off by it is closed with everything it did, so waiting is a courtesy, not a guarantee
 * that has to hold forever.
 */
const IDLE_WAIT_MS = 10 * 60_000;

/**
 * Whether anything is running, waiting in the queue, or working in the background. `jobs` is required, though it may
 * be undefined where no job store exists: leaving it out is how an update came to kill background work, so a caller
 * has to say so out loud.
 *
 * An approval waiting for a person is not: a restart keeps it and asks it again, where it used to answer it "deny"
 * — which is why a restart waited, up to ten minutes, for questions nobody was answering. A turn parked on one is
 * still running, and waited for until it stops waiting.
 */
export function busyWith(
  pipeline: { stats(): { running: number; waiting: number } } & Partial<CliCommands>,
  jobs: Pick<JobsPort, "listSnapshots"> | undefined,
): () => boolean {
  return () => {
    const queue = pipeline.stats();
    return queue.running + queue.waiting > 0 || (jobs !== undefined && working(jobs)) || (pipeline.cliCommands?.().length ?? 0) > 0;
  };
}

/**
 * The commands external agents' coding CLIs left running in the background (0.8.6): a restart stops each CLI and its
 * commands with it, so they are waited for as a background job is (`Pipeline.cliCommands`).
 */
export interface CliCommands {
  cliCommands(): WorkingJob[];
}

/** A background job a restart is waiting for, as it is reported: what it runs, and since when. */
export interface WorkingJob {
  id: string;
  command: string;
  startedAt: number;
}

/**
 * Background jobs still at work. A restart kills them, so an update that waited only for turns cut a
 * forty-minute build or a coding agent's run in half as soon as the turn that started it ended. A service
 * is left out: it serves until it is stopped, so waiting for one could only ever end at the timeout. The
 * newest hundred, as the watchdog reads them — running jobs are recent.
 */
export function workingJobs(jobs: Pick<JobsPort, "listSnapshots"> | undefined, clis?: Partial<CliCommands>): () => WorkingJob[] {
  return () => [
    ...(jobs?.listSnapshots({ limit: 100 }) ?? [])
      .filter((job) => job.status === "running" && !job.service)
      .map(({ id, command, startedAt }) => ({ id, command, startedAt })),
    ...(clis?.cliCommands?.() ?? []),
  ];
}

function working(jobs: Pick<JobsPort, "listSnapshots">): boolean {
  return workingJobs(jobs)().length > 0;
}

/**
 * Call `restart` once `busy` says nothing is running — or after `maxWaitMs`, whichever comes first.
 *
 * Except for `jobs`: a background job is waited for however long it takes. Cut off, a two-hour build or a
 * coding agent's run starts again from nothing, and a person who wants it stopped says `now`. A turn still
 * gives up at the cap: it is closed with what it did and taken up again after the restart, with any approval
 * it was waiting on kept and asked again.
 */
export function restartWhenIdle(input: {
  busy: () => boolean;
  restart: () => void;
  jobs?: () => WorkingJob[];
  maxWaitMs?: number;
  pollMs?: number;
  /** How long after being asked it first looks — 250 ms; a test passes its own rather than waiting this one out. */
  beatMs?: number;
  now?: () => number;
}): void {
  const now = input.now ?? Date.now;
  const started = now();
  const later = (ms: number) => setTimeout(contained(log, "a restart waiting for the daemon to be idle could not go on", tick), ms);
  function tick(): void {
    let idle: boolean;
    try {
      if (input.jobs?.().length) return void later(input.pollMs ?? 2_000);
      idle = !input.busy();
    } catch (err) {
      // A store that cannot say what is running is not one saying nothing is: waited on as for a turn, so the limit
      // below still ends the wait — where a throw out of this timer ended the daemon, and the restart with it.
      log.warn("could not tell whether anything is still running: waiting on", { error: String(err) });
      idle = false;
    }
    if (idle) return input.restart();
    if (now() - started >= (input.maxWaitMs ?? IDLE_WAIT_MS)) {
      log.warn("restarting with work still running: it waited as long as it waits", { waited_ms: now() - started });
      return input.restart();
    }
    later(input.pollMs ?? 2_000);
  }
  // After the swap, not before: a restart requested first would end the process holding the half-finished download.
  // And a beat after being asked, so the answer to whoever asked — a response, a chat reply — leaves first.
  later(input.beatMs ?? 250);
}

/** `the background job \`make build\` (12m)`, or the first three of several — what a restart is waiting for. */
export function describeJobs(jobs: readonly WorkingJob[], at: number = Date.now()): string {
  const one = (job: WorkingJob) => {
    const command = clip(job.command, 48);
    const seconds = Math.max(1, Math.round((at - job.startedAt) / 1000));
    return `\`${command}\` (${seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`})`;
  };
  if (jobs.length === 1) return `the background job ${one(jobs[0]!)}`;
  const named = jobs.slice(0, 3).map(one).join(", ");
  return `the ${jobs.length} background jobs ${named}${jobs.length > 3 ? ` and ${jobs.length - 3} more` : ""}`;
}

/**
 * When the follow-up is aimed *before* the swap starts.
 *
 * Far beyond any plausible download, and that is the whole job of this number. The row has to
 * exist before anything is touched — it is the only thing that survives a swap which kills the
 * process — but a row that is live is a row that can fire, and on a Raspberry Pi a 43 MB
 * download took 34 seconds. A 30-second follow-up therefore fired *into the update*, was
 * aborted by the restart, and being a one-shot was gone: the daemon came back on the new
 * version and nobody was told. Twice, before this was understood.
 *
 * So it is parked out here, and moved to the real delay once the swap is done. If the process
 * dies mid-swap and never moves it, this is when somebody gets told the update may not have
 * finished — late, but an alarm that exists beats one that was consumed early.
 */
const FALLBACK_SECONDS = 900;

export interface SelfUpdateRequest {
  message: string;
  delaySeconds: number;
  agentId: string;
  gatewayId: string;
  chatId: string;
}

/**
 * An operator standing in the dashboard needs no follow-up turn.
 *
 * The `--then` rule exists because a restart ends the conversation that asked for it, and an
 * agent that is no longer running cannot check whether the thing it did worked. A person with
 * the page open is not in that position: they are already watching, and a turn aimed at a
 * conversation they are not in is noise in somebody else's thread.
 *
 * So the follow-up is required on the agent's path and optional here, and which one is which
 * is decided by the caller passing a target or not — never by a default that guesses one.
 */
export type SelfUpdateTarget = SelfUpdateRequest | { watched: true };

/**
 * Do it, and return what to tell the caller before the process ends.
 *
 * The restart is deferred by a tick rather than called inline, so the tool result reaches
 * the model and the model's reply reaches the chat before the daemon goes away. Without
 * it the conversation's last visible event is the tool call, and the person watching sees
 * the agent stop mid-sentence — which is indistinguishable from a crash.
 *
 * `restart` says when the new version takes over, for the dashboard's words at its route (0.8.20); `note` is the CLI's,
 * and names the files it replaced and where the old ones are.
 */
export async function runSelfUpdate(
  deps: SelfUpdateDeps,
  request: SelfUpdateTarget,
): Promise<{ note: string; to: string; followUp: string | null; restart: "now" | "idle" | "jobs" }> {
  const followUp = "watched" in request ? null : scheduleFollowUp(deps, request);

  /**
   * Which half runs depends on whether a download is already sitting there.
   *
   * The dashboard downloads first and presses install second — the two confirmations exist
   * because they have different consequences. The agent has one call, having passed one
   * approval that covered both. Same ending either way.
   */
  const { report, plan } = deps.staged
    ? await installDownloaded(deps.dataDir)
    : await applyPluginUpdate(deps.dataDir);

  /**
   * Armed as the restart happens. Until then it is parked fifteen minutes out.
   *
   * Created early because that is the only way the follow-up survives a swap that kills the
   * process; armed late because the delay means "how long until I am back" and the clock
   * cannot start before the thing it is waiting for — which, now that a restart waits for the
   * daemon to go idle, is the restart and not the swap. The payload is rewritten at the same
   * time, since only now is the version it landed on known.
   */
  const restart = (): void => {
    if (followUp && !("watched" in request)) {
      try {
        deps.cron.update(
          followUp,
          {
            trigger: { kind: "at", at: Date.now() + request.delaySeconds * 1000 },
            payload: { kind: "agentTurn", message: followUpMessage(request.message, plan.to) },
          },
          "update",
        );
        log.info("follow-up re-armed", { job: followUp, in_seconds: request.delaySeconds, to: plan.to });
      } catch (err) {
        // The restart goes ahead: the files are already swapped, and a write that threw here used to stop it, leaving
        // the old version running. The follow-up is still parked, so it fires late rather than never.
        log.warn("could not arm the update's follow-up, so it fires at its parked time instead", { job: followUp, error: String(err) });
      }
    }
    deps.requestRestart(`update to ${plan.to}`);
  };
  const waits = Boolean(deps.busy) && !deps.immediately;
  restartWhenIdle({ busy: waits ? deps.busy! : () => false, restart, ...(waits && deps.jobs ? { jobs: deps.jobs } : {}), ...deps.pacing });
  const jobs = waits ? (deps.jobs?.() ?? []) : [];

  return {
    to: plan.to,
    followUp,
    restart: jobs.length > 0 ? "jobs" : waits ? "idle" : "now",
    note:
      `Replaced ${report.replaced.join(", ")}; the previous version is in ${report.backupDir}. ` +
      (jobs.length > 0
        ? `Restarting once ${describeJobs(jobs)} ${jobs.length === 1 ? "finishes" : "finish"}, however long that takes.`
        : waits
          ? "Restarting as soon as nothing is running, within ten minutes."
          : "Restarting now."),
  };
}

/** The turn that comes back. Created before anything is touched — see the header. */
function scheduleFollowUp(deps: SelfUpdateDeps, request: SelfUpdateRequest): string {
  const job = deps.cron.create({
    agentId: request.agentId,
    name: "wake-up: updating this daemon",
    // Live from the moment it is written, so a swap that kills the process still leaves an alarm.
    enabled: true,
    /**
     * Parked, not scheduled — see {@link FALLBACK_SECONDS}. `runSelfUpdate` moves it to the
     * delay the caller asked for once the swap is finished.
     *
     * An absolute instant rather than a duration string: `JobTrigger` holds epoch
     * milliseconds, and the `"20s"` spelling belongs to the parser the control API runs.
     */
    trigger: { kind: "at", at: Date.now() + FALLBACK_SECONDS * 1000 },
    payload: { kind: "agentTurn", message: followUpMessage(request.message, null) },
    target: { gatewayId: request.gatewayId, chatId: request.chatId },
    delivery: { mode: "announce" },
    // The conversation's own history, so the follow-up reads as a continuation.
    session: "chat",
    keepAfterRun: false,
    createdBy: "update",
  });
  log.info("follow-up parked", { job: job.id, fallback_in_seconds: FALLBACK_SECONDS });
  return job.id;
}

/**
 * What the agent reads when it comes back.
 *
 * `expected` is the version the swap actually landed on, which is unknown when the row is
 * first written and known when it is re-armed. It is in the message because a cron turn has
 * **nobody to ask**: every tool that could check the version is gated, and an approval
 * prompt in a turn with no human behind it is refused rather than parked. Measured on the
 * Pi — the agent reached for the `nouride` tool and got "there is nobody to ask right now".
 *
 * So the turn is told what to expect and asked to say what it can see, rather than being
 * sent to run a command it will be refused.
 */
function followUpMessage(asked: string, expected: string | null): string {
  return (
    `${asked}\n\n` +
    `(You scheduled this before updating the daemon, and it has restarted since: this is a ` +
    `fresh turn.${expected ? ` The swap reported landing on ${expected}.` : ""} Check rather than ` +
    `assume, and say plainly if you cannot: a scheduled turn has no human behind it, so any tool ` +
    `that needs approval will be refused here.)`
  );
}

/**
 * The `update` tool's two closures, or nothing when this build cannot update.
 *
 * Assembled here rather than in `index.ts` because that file documents boot *order* and this
 * is boot *assembly* — and because the pairing matters: the tool's `apply` must be the one
 * that schedules the follow-up first, and a caller free to pass any function could pass one
 * that does not.
 */
export function updateToolOptions(deps: SelfUpdateDeps): UpdateToolOptions | undefined {
  if (!updateSupported()) return undefined;
  return {
    check: () => checkForUpdate(deps.dataDir),
    apply: (wake) => runSelfUpdate(deps, wake),
  };
}
