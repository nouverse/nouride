/**
 * The ticker: what is due, run it, record it, schedule the next one.
 *
 * ## Why this lives in the daemon at all
 *
 * An early plan deferred cron with "a system timer does it", and for a timer that runs a script
 * that is true. It stops being true the moment the job has to reach a Telegram chat, run against
 * an agent's own history, or be visible where the operator already looks. None of that exists
 * outside the process holding the gateway sockets.
 *
 * ## The three failure modes this is shaped around
 *
 * - **Double firing.** A tick that takes longer than its interval finds the same job still due.
 *   So a job is *claimed* — `next_run_at` cleared in the same conditional statement that checks
 *   it — before anything runs, and an in-flight set refuses a second start regardless.
 * - **Replaying a backlog.** A daemon down for three days must not open with three days of
 *   reminders. Anything overdue by more than the catch-up window is rescheduled, not run.
 * - **Failing silently forever.** A recurring job whose script was deleted fails on schedule
 *   until someone notices. The store's streak counter disables it and says why.
 *
 * ## What runs, and with whose permission
 *
 * `command` payloads execute argv on the host with no model and **no approval gate** — nothing
 * inspects them at all. The tool that once refused this is gone; the gate is now hardline classification of the argv. Payload kinds are still only
 * `systemEvent` and `agentTurn`, and a command job has to come from an operator through the CLI,
 * the dashboard or the control API. An `agentTurn` still meets the policy, the blocked list and
 * the hardline classes; see `unattendedApproval` for what it does about a gate nobody can answer.
 */

import { runsOnChatHistory, sessionFor, type CronSessionRef } from "./addressing.ts";
import { commandTurnMessage, unattendedPreamble, WEBHOOK_PAYLOAD, withDeliveredBody, withTriggerBody } from "./prompts.ts";
import {
  contained,
  createLogger,
  toUserMessage,
  type Job,
  type CronSection,
  type HeldAction,
  type JobRun,
  type JobStep,
  type JobTarget,
} from "@nouride/shared";
import type { CronPort, RunOutcome, RunState } from "@/modules/cron/cron.store.ts";
import { APPROVAL_WAIT_MS, type StepHands } from "./steps.ts";
import { StepRuns, type Parked } from "./step-runs.ts";
import type { MissionEnd } from "@/modules/missions/job-runs.ts";
import { deliverResult, reportFailure, undelivered, type Delivered } from "./delivery.ts";
import { runJobCommand } from "./job-command.ts";
import { Keeper, type Quiet } from "./quiet.ts";
import type { WatchStore } from "./watch.store.ts";
import type { AskAnswered } from "./step-asks.ts";
import type { AuditPort } from "@/commons/audit.store.ts";

const log = createLogger("cron");

export interface JobTurnRequest {
  job: Job;
  /** The conversation whose history this turn reads and appends to. */
  session: CronSessionRef;
  message: string;
  model?: string;
  signal: AbortSignal;
  /** What the message carried from outside — the payload of the webhook that fired it (`TurnRequest.outsideContent`). */
  outsideContent?: string[];
}

export interface JobTurnResult {
  text: string;
  /** Set when the turn could not complete. Already shaped for a human — no stack traces. */
  error?: string;
  /** Not run: its agent was in a turn in that chat. The run is `skipped`, not failed. */
  skipped?: string;
  /** Cut off by a daemon restart. The run is `interrupted`: nothing failed, and nobody is sent a failure report. */
  interrupted?: string;
  /** What the job's guards held with nobody there to ask (0.8.0) — kept on the run. */
  held?: HeldAction[];
}

/**
 * Everything the scheduler needs from the rest of the daemon, as functions.
 *
 * Not the pipeline itself, for the same reason `delegate` and `exec`'s job runner take closures:
 * a component that can reach the pipeline can reach everything the pipeline can, and this one
 * runs unattended.
 */
export interface CronExecutors {
  runTurn(request: JobTurnRequest): Promise<JobTurnResult>;
  /**
   * Enqueue a cron turn into the pipeline as a regular message. Returns immediately — the turn
   * runs through the normal pipeline path (routing → queue → turn → reply) instead of being
   * awaited here. The cron job succeeds at dispatch time, not at turn completion.
   *
   * `false` means the message was **not** accepted: no gateway for the target, or the queue refused
   * it (full, draining, or a duplicate). Returned rather than swallowed because the run record is the
   * only place an operator looks, and one that says "dispatched" for a message that was dropped is a
   * scheduled job that silently stops running.
   */
  dispatchTurn(job: Job, message: string, outsideContent?: string[]): boolean;
  /**
   * Put text into a conversation: delivered, or why not — the gateway is gone, or the platform refused it. `said` is the
   * job a run's output is from: delivered, it goes into its agent's conversation there too, as that agent's words. A
   * failure notice is the daemon's and goes without it.
   */
  deliver(target: JobTarget, text: string, said?: { agentId: string; job: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * The sandbox a `command` payload runs in — the owning agent's workspace and the exec
   * environment allowlist. `null` when the agent is no longer loaded, which is a job error
   * rather than a command run somewhere arbitrary.
   */
  commandSandbox(job: Job): { cwd: string; env: Record<string, string>; secrets?: Record<string, string> } | null;
  /** POST a finished-run payload. Absent means webhook delivery is unavailable. */
  webhook?(url: string, body: unknown): Promise<void>;
  /**
   * Start a `mission` job's run (0.8.0): the mission it started, the one of its runs still working — a job runs one at
   * a time — or why it could not start. Absent where missions are not run.
   */
  startMission?(job: Job, body: string | undefined): { started: string } | { busy: string } | { refused: string };
  /** The daemon's alert channel (`[alerts]`), keyed for its cooldown. Absent means a failure is in the log only. */
  alert?(key: string, text: string): Promise<unknown>;
  /** Whether an agent is asleep (0.8.0): a run of its job due then is recorded as skipped, whatever the job runs. */
  asleep?(agentId: string): boolean;
  /** How a mission a step started stands, or null when there is none by that id. Absent where missions are not run. */
  missionEnd?(id: string): MissionEnd | null;
  /**
   * A step's question put to a person where the job reports (`step-asks.ts`): the card it was asked on, when it has
   * buttons to take away later. Absent, or with nothing returned, the dashboard alone asks.
   */
  ask?(job: Job, runId: string, step: Extract<JobStep, { kind: "approval" }>, shown: string, until: number): Promise<RunState["card"] | undefined>;
  /** That card rewritten: answered somewhere else, or by nobody. */
  settleAsk?(card: NonNullable<RunState["card"]>, text: string): void;
}

export interface CronSchedulerOptions {
  store: CronPort;
  config: CronSection;
  executors: CronExecutors;
  audit?: AuditPort;
  now?: () => number;
  /** The longest the timer sleeps: `MAX_SLEEP_MS`. A test's is shorter. */
  maxSleepMs?: number;
  /** What a job that watches keeps between runs, and what is held for the quiet hours. Absent: neither is kept. */
  watch?: WatchStore;
  /** The install's quiet hours (`quiet.ts`). Absent: nothing is ever held. */
  quiet?: Quiet;
}

/** Why a job set to tell once is off: `disabled_reason`, which its page puts into words. */
export const TOLD = "told";

/** The shortest the timer is ever set for — see `arm`. */
const MIN_SLEEP_MS = 1_000;

/**
 * The longest it is set for — see `arm`. A minute, so a wall clock that jumps is noticed within one. It was `[cron]
 * tick_interval_ms` until 0.8.0, which nobody tuned: a fixed value now (`config/global/gone-keys.ts`).
 */
const MAX_SLEEP_MS = 60_000;

export class CronScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private readonly inFlight = new Map<string, AbortController>();
  private started = false;
  private stopping = false;
  /** Runs of several steps: begun here, and taken up again after a wait (`step-runs.ts`). */
  private readonly stepRuns: StepRuns;
  /** The quiet hours and what they keep (`quiet.ts`), where both were handed in. */
  private readonly keeper?: Keeper;

  constructor(private readonly options: CronSchedulerOptions) {
    if (options.watch && options.quiet) this.keeper = new Keeper(options.watch, options.quiet);
    this.stepRuns = new StepRuns({
      store: options.store,
      hands: (job, signal, runId, byHand) => this.stepHands(job, signal, runId, byHand),
      enter: (jobId) => {
        if (this.inFlight.has(jobId)) return null;
        const controller = new AbortController();
        this.inFlight.set(jobId, controller);
        return controller;
      },
      leave: (jobId) => void this.inFlight.delete(jobId),
      ended: (job, runId, outcome, how) => this.finish(job, runId, outcome, { ...how, cause: "resumed", startedAt: this.now }),
      ...(options.executors.missionEnd ? { mission: (id: string) => options.executors.missionEnd!(id) } : {}),
      ...(options.executors.settleAsk ? { settleCard: (card: NonNullable<RunState["card"]>, text: string) => options.executors.settleAsk!(card, text) } : {}),
      now: () => this.now,
    });
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Reconcile what the last shutdown left behind, then start ticking.
   *
   * Reconciliation first and synchronously: a run row that says `running` with no process behind
   * it renders in the dashboard as a job still working, and the first tick must not add more.
   */
  start(): void {
    if (!this.options.config.enabled) {
      log.info("scheduler disabled by config");
      return;
    }
    if (this.started) return;
    this.started = true;

    const interrupted = this.options.store.reconcileInterrupted();
    if (interrupted > 0) log.warn("cron runs interrupted by the last shutdown", { runs: interrupted });
    this.rearmInterrupted();
    this.stepRuns.recover();

    this.catchUp();

    this.options.store.onScheduleChange(() => this.arm());
    this.arm();

    const pending = this.options.store.list().length;
    log.info("scheduler started", { jobs: pending, max_sleep_ms: this.options.maxSleepMs ?? MAX_SLEEP_MS });
  }

  /**
   * One timer, set for the soonest job that is due — not a ticker.
   *
   * It used to wake every `tick_interval_ms` (a setting until 0.8.0), one second, to ask SQLite whether anything was due — while
   * `min_interval_ms` forbids any schedule shorter than a minute. Sixty wake-ups a minute on an idle box,
   * half of all it had (2026-10-15). Now it sleeps until the next `next_run_at`, so a job fires on its
   * second instead of within one, and the store says when a write moves that time (`onScheduleChange`).
   *
   * Two bounds. At least `MIN_SLEEP_MS`, so a job that is due but cannot be claimed — already running by
   * hand — is looked at once a second rather than in a tight loop. At most `MAX_SLEEP_MS`, so a wall
   * clock that jumps is noticed within that much instead of whenever a delay worked out against the old
   * clock runs out: a Pi has no RTC, and NTP moves its clock by hours after boot.
   */
  private arm(): void {
    if (!this.started || this.stopping) return;
    clearTimeout(this.timer);
    const ceiling = this.options.maxSleepMs ?? MAX_SLEEP_MS;
    let next: number | null;
    try {
      next = this.options.store.nextDueAt();
    } catch (err) {
      log.warn("could not read when the next job is due", { error: String(err) });
      next = null;
    }
    // A step that waits for a person runs out of time on this timer too.
    const deadline = this.stepRuns.nextDeadline();
    if (deadline !== null && (next === null || deadline < next)) next = deadline;
    const delay = next === null ? ceiling : Math.min(ceiling, Math.max(MIN_SLEEP_MS, next - this.now));
    this.timer = setTimeout(
      contained(log, "cron tick failed", () => {
        this.timer = undefined;
        // Armed again whatever the tick did: a store that threw this time is asked again on the next one.
        return this.tick().finally(() => this.arm());
      }),
      delay,
    );
  }

  /**
   * The jobs those runs had claimed.
   *
   * A run claims its job by clearing `next_run_at`, and `settle` sets the next one when the run ends. A run
   * that never ended left it unset, and `due()` only selects jobs that have one — so that job would never
   * run again, silently. Nothing else leaves a job enabled with no next run: a one-shot that ran is deleted
   * or disabled by `settle`.
   *
   * A recurring job is given its next time from now (`update` recomputes it), unless its schedule has none
   * left. A one-shot may have partly run, so it is disabled rather than fired again by itself, and its run
   * history says it was interrupted — `cron run` retries it. Its time has always passed by then — it was
   * running — so it is not asked for a next one: the box found that filter leaving it enabled for good.
   */
  private rearmInterrupted(): void {
    const store = this.options.store;
    const stuck = store
      .list()
      // A job whose run waits for a mission or a person has no next time on purpose: its run gives it one when it ends.
      .filter((job) => job.enabled && job.nextRunAt === undefined && !this.stepRuns.waitingOf(job.id) && (job.trigger.kind === "at" || store.nextRun(job.trigger, this.now) !== null));
    for (const job of stuck) {
      if (job.trigger.kind === "at") store.setEnabled(job.id, false, "daemon restart");
      else store.update(job.id, {}, "daemon restart");
    }
    if (stuck.length > 0) log.warn("cron jobs whose run died with the last process", { rearmed: stuck.filter((job) => job.trigger.kind !== "at").length, disabled: stuck.filter((job) => job.trigger.kind === "at").length });
  }

  /**
   * Decide what to do with everything that came due while the daemon was down.
   *
   * Inside the catch-up window a missed reminder is still worth having, so it is simply left due
   * and the first tick fires it. Outside it, the job is moved on without running: three days of
   * missed reminders arriving at once is noise at the worst possible moment, and an
   * every-five-minutes job would arrive as several hundred of them.
   */
  private catchUp(): void {
    const now = this.now;
    const tooLate = now - this.options.config.catchupWindowMs;

    for (const job of this.options.store.due(tooLate)) {
      if (job.trigger.kind === "at") {
        // A one-shot cannot be moved on — there is nowhere to move it to. Recorded and disabled so
        // the operator finds out it did not happen, rather than finding an empty list.
        this.options.store.finishRun(this.options.store.startRun(job.id).id, {
          status: "skipped",
          result: `missed: the daemon was not running at ${new Date(job.nextRunAt ?? now).toISOString()}`,
        });
        this.options.store.settle(job, { status: "skipped", result: "missed while the daemon was down" });
        log.warn("one-shot job missed its time", { job: job.id, name: job.name });
        continue;
      }

      // Recurring: forward to the next occurrence from now, with no run recorded. Nothing happened,
      // and a run row saying otherwise would be a lie in the one place the operator checks.
      this.options.store.settle(job, { status: "skipped", result: "missed while the daemon was down" });
      log.info("recurring job rescheduled after downtime", { job: job.id, name: job.name });
    }
  }

  /** Stop ticking and wait for in-flight runs, then abort whatever is left. */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inFlight.size === 0) return;

    log.info("waiting for cron runs to finish", { runs: this.inFlight.size });
    const deadline = this.now + timeoutMs;
    while (this.inFlight.size > 0 && this.now < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const [id, controller] of this.inFlight) {
      log.warn("aborting cron run at shutdown", { job: id });
      controller.abort();
    }
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    this.stepRuns.expire();
    // The quiet hours over: what was kept is said. Looked at on every tick, so within the timer's longest sleep of
    // their end, a minute: the morning's message has no second to be on.
    await this.keeper?.say(this.options.store, this.options.executors, this.stepRuns);
    for (const job of this.options.store.due(this.now)) {
      if (this.inFlight.has(job.id)) continue;
      // A job changed while its run waits is given a time again (`CronStore.update`), and would be found due here
      // every second for as long as the wait lasts, a day or more. Its time is taken back: its run gives it one.
      if (this.stepRuns.waitingOf(job.id)) {
        this.options.store.claim(job);
        continue;
      }
      if (!this.options.store.claim(job)) continue;
      // Not awaited: one slow `agentTurn` must not hold back every other job's tick. Errors are
      // handled inside `execute`, so nothing escapes here.
      void this.execute(job, "schedule");
    }
  }

  /** What the quiet hours keep now (`Keeper.kept`): what a page says is waiting, and until when. */
  kept(): { jobIds: string[]; until: number } | null {
    return this.keeper?.kept() ?? null;
  }

  /** Whether a run of this job is going now — what `runNow` would refuse a second start for. */
  isRunning(id: string): boolean {
    return this.inFlight.has(id) || this.stepRuns.waitingOf(id) !== null;
  }

  /** A person's answer to a step that waits for one, from a chat's button or the dashboard. */
  answerRun(runId: string, go: boolean, by: string, via: "chat" | "dashboard"): AskAnswered {
    return this.stepRuns.answer(runId, go, by, via);
  }

  /** A mission ended or changed: a run of several steps that waits for it goes on once it is over. */
  missionChanged(missionId: string): void {
    this.stepRuns.missionChanged(missionId);
  }

  /**
   * Run a job now, regardless of its schedule.
   *
   * The CLI's `nouride cron run <id>`, and the reason a scheduled job is testable at all: waiting
   * until 09:00 to find out whether a daily report works is not a development loop. It deliberately
   * does **not** claim or consume the pending occurrence — forcing a run is out-of-band, and a
   * forced test should not cancel tonight's real one.
   */
  async runNow(
    id: string,
    actor: string,
    trigger?: TriggerContext,
  ): Promise<RunOutcome | Parked | { status: "unavailable"; result: string }> {
    const job = this.options.store.get(id);
    if (!job) return { status: "unavailable", result: "no such job" };
    // One run at a time, and a run that waits is still its job's run.
    const waiting = this.stepRuns.waitingOf(job.id);
    if (waiting) return { status: "unavailable", result: `its last run is still waiting for ${waiting.wait.kind === "mission" ? `mission ${waiting.wait.missionId}` : "a person's answer"}` };
    // Also the whole of a webhook's abuse story. A public endpoint that starts a provider call per
    // request is a bill waiting to happen; one that refuses while its own last run is still going
    // cannot be made to run more often than it can finish.
    if (this.inFlight.has(job.id)) return { status: "unavailable", result: "that job is already running" };

    this.options.audit?.record({
      action: trigger ? "cron_run_webhook" : "cron_run_now",
      agentId: job.agentId,
      actor,
      details: { job: job.id, name: job.name },
    });
    /**
     * A delivery is settled as a scheduled run is: counted, and a hook that fails every call stops itself as a job does.
     * It was not until 0.8.0, so the Webhooks page read 0 deliveries and an empty Failing filter however many came.
     * A run by hand settles nothing — a forced test must not count, nor cancel tonight's real run.
     */
    return await this.execute(job, trigger ? "webhook" : "manual", {
      // A job started by hand has no other kind of run: each one is its run, and counts.
      advanceSchedule: (trigger !== undefined && job.trigger.kind === "webhook") || job.trigger.kind === "manual",
      ...(trigger ? { trigger } : {}),
    });
  }

  private async execute(
    job: Job,
    cause: "schedule" | "manual" | "webhook",
    opts: { advanceSchedule?: boolean; trigger?: TriggerContext } = {},
  ): Promise<RunOutcome | Parked> {
    const controller = new AbortController();
    this.inFlight.set(job.id, controller);
    const run = this.options.store.startRun(job.id);
    const startedAt = this.now;
    const settles = opts.advanceSchedule !== false;
    const byHand = cause === "manual";

    let outcome: RunOutcome | Parked;
    try {
      outcome = await this.dispatch(job, controller.signal, { run, settles, byHand, ...(opts.trigger ? { trigger: opts.trigger } : {}) });
    } catch (err) {
      // Anything thrown past `dispatch` is a bug in it, not in the job. Recorded against the job
      // anyway: an unattended run that vanishes without a row is the failure that costs hours.
      outcome = { status: "error", result: toUserMessage(err) };
      log.error("cron run threw", { job: job.id, error: String(err) });
    } finally {
      this.inFlight.delete(job.id);
    }

    if (outcome.status === "waiting") {
      // Not over: nothing is settled or reported. A run forced by hand left the job's own time standing, which would
      // start a second run beside this one: taken now, and given back when the run ends (`finish`).
      if (!settles && job.nextRunAt !== undefined && job.trigger.kind !== "at") this.options.store.claim(job);
      this.arm();
      return outcome;
    }
    await this.finish(job, run.id, outcome, { settles, byHand, cause, startedAt });
    // What `finish` read of the run and nobody else is told: the hashes it kept, and whether it told.
    const shown = { ...outcome };
    delete shown.said;
    delete shown.told;
    return shown;
  }

  /** A run over, at once or after it waited: written down, its job settled when the run counts for it, a failure told. */
  private async finish(job: Job, runId: string, outcome: RunOutcome, how: { settles: boolean; byHand: boolean; cause: string; startedAt: number }): Promise<void> {
    this.options.store.finishRun(runId, outcome);
    if (how.settles) this.options.store.settle(job, outcome);
    // What its marked steps said is what the next run compares with, once this one ended well: a run that failed before
    // anybody heard keeps nothing, so the next one says it. A person's no, or nobody's answer, was heard.
    if (outcome.said && (outcome.status === "success" || outcome.status === "skipped")) this.options.watch?.keepSaid(job.id, outcome.said);
    // Set to tell once, and it told: off, with why. Held for the quiet hours counts, or the morning would hear it from
    // every run of the night. Not a run by hand: a person trying it out has not been told what it watches for.
    if (job.delivery.once && job.delivery.mode !== "none" && !how.byHand && outcome.status === "success" && outcome.told) {
      this.options.store.turnOff(job.id, TOLD);
      log.info("a job set to tell once told, and turned itself off", { job: job.id, name: job.name });
    }
    // A run by hand that waited had taken its job's time (`execute`): it has one again, counted from now.
    else if (how.cause === "resumed" && job.trigger.kind !== "at" && this.options.store.get(job.id)?.enabled && this.options.store.get(job.id)?.nextRunAt === undefined) this.options.store.update(job.id, {}, "cron");

    const level = outcome.status === "error" ? "warn" : "info";
    log[level]("cron run finished", {
      job: job.id,
      name: job.name,
      status: outcome.status,
      cause: how.cause,
      duration_ms: this.now - how.startedAt,
      ...(outcome.result ? { result: outcome.result.slice(0, 300) } : {}),
    });

    // A failed unattended run has to reach a person. The chat the job points at is the one place
    // the operator is already looking, and it is where the successful runs would have gone.
    if (outcome.status !== "error") return;
    // Inside the quiet hours the failure is kept with the rest and said first when they end: nothing can be done about
    // it at three in the morning. One whose chat is the problem goes to the alert channel as it always did.
    if (!outcome.unreachable && this.keeper?.keep(job, how.byHand, { runId, kind: "failed", text: outcome.result.slice(0, 1000) })) return;
    await reportFailure(this.options.executors, job, outcome);
  }

  /** A run's words to where its job reports: at once, or kept for the end of the quiet hours. */
  private async say(job: Job, runId: string, text: string, byHand: boolean): Promise<Delivered> {
    if (this.keeper?.keep(job, byHand, { runId, kind: "said", text })) return { ok: true };
    return await deliverResult(this.options.executors, this.now, job, text);
  }

  private async dispatch(
    job: Job,
    signal: AbortSignal,
    how: { run: Pick<JobRun, "id">; settles: boolean; byHand: boolean; trigger?: TriggerContext },
  ): Promise<RunOutcome | Parked> {
    const trigger = how.trigger;
    // What a run that delivered its words says of itself, for a job set to tell once.
    const told = { told: true as const };
    // Inside the quiet hours nothing is put into the chat: a turn is run here and its words are kept.
    const kept = this.keeper?.holds(job, how.byHand) === true;
    /**
     * Asleep, it takes no work: checked here for every kind. Only a job's own turn checked it, so a reminder or a command
     * still ran, and a turn into its chat was held and replayed at its wake once per occurrence — an every-15-minutes job
     * overnight pushing out what else was held for it — each run recorded as dispatched.
     */
    if (this.options.executors.asleep?.(job.agentId)) return { status: "skipped", result: `agent asleep: ${job.agentId}` };
    switch (job.payload.kind) {
      case "systemEvent": {
        /**
         * No provider call at all. This is the payload that still works when the model is down,
         * which is most of what a reminder actually needs.
         *
         * The trigger body is appended, which it was not until a webhook was pointed at this mode.
         * A scheduled reminder has no body and reads exactly as before; a *webhook* in this mode had
         * been dropping the caller's payload silently, so it delivered the same fixed sentence
         * however much the sender put in the request — which makes the cheapest mode the one that
         * cannot say what happened.
         */
        const delivered = await this.say(job, how.run.id, withDeliveredBody(job.payload.text, trigger), how.byHand);
        return delivered.ok
          ? { status: "success", result: "delivered", ...told }
          : undelivered(delivered);
      }

      case "agentTurn": {
        /**
         * Fire-and-forget for `announce` delivery — but only when the history is the chat's.
         *
         * The dispatch path pushes the job in as if a person had sent it, and the agent's turn runs
         * the normal route: routing, session, tool loop, reply. That reply goes back to *the
         * conversation the message came from*, which is the whole reason it can only be used for
         * `session: "chat"`. For the other two modes the conversation the message comes from is
         * `cron:<jobId>`, an address no platform can deliver to — so a job with `announce` +
         * `isolated` dispatched happily, reported `"dispatched"` as a success, and its answer was
         * sent to a channel id Discord has never heard of. Nothing arrived, and the run history said
         * it had.
         *
         * So those run synchronously and the scheduler delivers the text itself, exactly as `none`
         * and `webhook` already did. What is lost is the typing indicator in the target chat; what is
         * gained is that the message shows up.
         */
        const prompt = withTriggerBody(job.payload.message, trigger);
        // Whoever called the endpoint wrote the payload: what the turn keeps after reading it waits for a person.
        const outside = trigger?.body?.trim() ? [WEBHOOK_PAYLOAD] : undefined;

        if (job.delivery.mode === "announce" && runsOnChatHistory(job) && !kept) {
          const message = unattendedPreamble(job, prompt);
          if (!this.options.executors.dispatchTurn(job, message, outside)) {
            return { status: "error", result: "the pipeline would not accept the turn" };
          }
          return { status: "success", result: "dispatched", ...told };
        }

        const result = await this.runTurn(job, prompt, job.payload.model, signal, outside);
        // What its guards held goes on the run however it ended, for a person to allow always (0.8.0).
        const held = result.held?.length ? { held: result.held } : {};
        if (result.skipped) return { status: "skipped", result: result.skipped, ...held };
        if (result.interrupted) return { status: "interrupted", result: result.interrupted, ...held };
        if (result.error) return { status: "error", result: result.error, ...held };
        if (!result.text.trim()) {
          return { status: "success", result: "the agent had nothing to report", ...held };
        }
        const delivered = await this.say(job, how.run.id, result.text, how.byHand);
        return delivered.ok
          ? { status: "success", result: result.text.slice(0, 2000), ...held, ...told }
          : { ...undelivered(delivered), ...held };
      }

      case "steps":
        return await this.stepRuns.begin(job, how.run, signal, trigger, { settles: how.settles, byHand: how.byHand });

      case "mission": {
        /**
         * Long work, as a mission (0.8.0): started and left to run — it survives a restart, parks what needs a person, and
         * ends at the reviewer. The run records which mission it started; that mission's page and its notices in the
         * job's chat say how it went. A run due while the last one still works is skipped, and says so.
         */
        const run = this.options.executors.startMission?.(job, trigger?.body) ?? { refused: "missions are not run in this process" };
        if ("busy" in run) return { status: "skipped", result: `the last run, mission ${run.busy}, is still working` };
        if ("refused" in run) return { status: "error", result: run.refused };
        return { status: "success", result: `started mission ${run.started}`, ...told };
      }

      case "command": {
        const ran = await runJobCommand(this.options.executors, this.options.config, job, job.payload);
        if ("error" in ran) return { status: "error", result: ran.error };
        const output = ran.output;

        /**
         * Nothing printed: nothing to deliver and nothing for the agent to read (0.8.17). So a check every five
         * minutes that finds nothing costs no turn and sends nothing, `--then agent` too, where it used to wake the agent
         * with an empty output each time. Its run says so. A failure above is not an empty run, and is reported as before.
         */
        if (!output.trim()) {
          return { status: "success", result: job.payload.then === "deliver" ? "exit 0, no output" : "exit 0, no output: the agent was not woken" };
        }

        if (job.payload.then === "deliver") {
          const delivered = await this.say(job, how.run.id, output, how.byHand);
          return delivered.ok
            ? { status: "success", result: output.slice(0, 2000), ...told }
            : undelivered(delivered);
        }

        // The token-efficient shape: the command has already produced the facts, so the model is
        // asked to do the one thing it is needed for. A turn that had to call `exec` itself would
        // spend two round trips discovering what is already in hand.
        // Same condition as the `agentTurn` case above, and for the same reason: the dispatch path's
        // reply goes to the conversation the message came from, which only reaches a person when
        // that conversation is the target chat.
        if (job.delivery.mode === "announce" && runsOnChatHistory(job) && !kept) {
          const message = unattendedPreamble(job, commandTurnMessage(job, output));
          if (!this.options.executors.dispatchTurn(job, message)) {
            return { status: "error", result: "the pipeline would not accept the turn" };
          }
          return { status: "success", result: "dispatched", ...told };
        }
        const turn = await this.runTurn(job, commandTurnMessage(job, output), undefined, signal);
        const held = turn.held?.length ? { held: turn.held } : {};
        if (turn.error) return { status: "error", result: turn.error, ...held };
        if (!turn.text.trim()) return { status: "success", result: "the agent had nothing to report", ...held };
        const delivered = await this.say(job, how.run.id, turn.text, how.byHand);
        return delivered.ok
          ? { status: "success", result: turn.text.slice(0, 2000), ...held, ...told }
          : { ...undelivered(delivered), ...held };
      }
    }
  }

  /**
   * What a job of several steps runs with (`steps.ts`): each step done the way a job of that one kind is. A step's turn
   * is its own job to the pipeline, so its guards weigh it against that step's words; another agent's starts fresh, in
   * a history of its own. A turn is always run here and never put into the chat, since the next step waits for its words.
   */
  private stepHands(job: Job, signal: AbortSignal, runId: string, byHand: boolean): StepHands {
    return {
      command: (step, input) => runJobCommand(this.options.executors, this.options.config, job, step, input),
      saidBefore: (stepId) => this.options.watch?.saidBefore(job.id, stepId),
      turn: async (step, message, outside) => {
        const own = !step.agentId || step.agentId === job.agentId;
        const asJob: Job = { ...job, agentId: step.agentId ?? job.agentId, session: own ? job.session : "fresh", payload: { kind: "agentTurn", message: step.message } };
        return await this.runTurn(asJob, message, step.model, signal, outside ? [WEBHOOK_PAYLOAD] : undefined);
      },
      deliver: (text) => this.say(job, runId, text, byHand),
      mission: (step, request) =>
        this.options.executors.startMission?.({ ...job, agentId: step.agentId ?? job.agentId, payload: step }, request) ?? { refused: "missions are not run in this process" },
      ask: async (step, shown) => {
        // Inside the quiet hours the question is kept and asked when they end; the dashboard lists it meanwhile.
        if (this.keeper?.keep(job, byHand, { runId, stepId: step.id, kind: "ask", text: shown })) return { from: this.keeper.endsAt() };
        const card = await this.options.executors.ask?.(job, runId, step, shown, this.now + (step.timeoutMs ?? APPROVAL_WAIT_MS));
        return card ? { card } : undefined;
      },
      progress: (outcomes) => this.options.store.progressRun(runId, outcomes),
      stopping: () => this.stopping || signal.aborted,
      now: () => this.now,
    };
  }

  private async runTurn(
    job: Job,
    message: string,
    model: string | undefined,
    signal: AbortSignal,
    outsideContent?: string[],
  ): Promise<JobTurnResult> {
    return await this.options.executors.runTurn({
      job,
      session: sessionFor(job),
      message,
      ...(model ? { model } : {}),
      signal,
      ...(outsideContent ? { outsideContent } : {}),
    });
  }
}

/**
 * What the request that fired a job carried.
 *
 * Only a body so far. Headers were left out on purpose: the useful ones are a signature and a
 * content type, both of which are the *route's* business to check, and the rest are a way to get
 * arbitrary attacker-controlled strings into a prompt for no benefit anybody asked for.
 */
export interface TriggerContext {
  body?: string;
  /** For the log and the run record — `github`, `manual`, whatever the caller called itself. */
  source?: string;
}
