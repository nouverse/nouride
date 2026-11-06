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

import { deliveryTarget, runsOnChatHistory, sessionFor, type CronSessionRef } from "./addressing.ts";
import { commandTurnMessage, unattendedPreamble, WEBHOOK_PAYLOAD, withDeliveredBody, withTriggerBody } from "./prompts.ts";
import {
  contained,
  createLogger,
  toUserMessage,
  type Job,
  type CronSection,
  type HeldAction,
  type JobTarget,
  type SandboxOptions,
} from "@nouride/shared";
import { runCommand } from "@nouride/runtime";
import { maskSecrets } from "@nouride/secrets";
import type { CronPort, RunOutcome } from "@/modules/cron/cron.store.ts";
import type { AuditPort } from "@/commons/audit.store.ts";

const log = createLogger("cron");

export interface JobTurnRequest {
  job: Job;
  /** The conversation whose history this turn reads and appends to. */
  session: CronSessionRef;
  message: string;
  model?: string;
  signal: AbortSignal;
  /** What the message carried from outside — the payload of the webhook that fired it (S13, `TurnRequest.outsideContent`). */
  outsideContent?: string[];
}

export interface JobTurnResult {
  text: string;
  /** Set when the turn could not complete. Already shaped for a human — no stack traces. */
  error?: string;
  /** Not run: its agent was in a turn in that chat (P1). The run is `skipped`, not failed. */
  skipped?: string;
  /** Cut off by a daemon restart (P11). The run is `interrupted`: nothing failed, and nobody is sent a failure report. */
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
}

/** A run's text delivered, or why not — `unreachable` when the job's own chat would not take it. */
type Delivered = { ok: true } | { ok: false; error: string; unreachable?: true };

/** A run whose output did not land is a failed run, and says whether its chat was the reason. */
function undelivered(delivered: Extract<Delivered, { ok: false }>): RunOutcome {
  return { status: "error", result: delivered.error, ...(delivered.unreachable ? { unreachable: true } : {}) };
}

export interface CronSchedulerOptions {
  store: CronPort;
  config: CronSection;
  executors: CronExecutors;
  audit?: AuditPort;
  now?: () => number;
  /** The longest the timer sleeps: `MAX_SLEEP_MS`. A test's is shorter. */
  maxSleepMs?: number;
}

/** Output past this is cut before it becomes a chat message. Chat platforms chunk; humans do not. */
const MAX_DELIVERED_CHARS = 4000;

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

  constructor(private readonly options: CronSchedulerOptions) {}

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
   * half of all it had (E5, 2026-10-15). Now it sleeps until the next `next_run_at`, so a job fires on its
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
      .filter((job) => job.enabled && job.nextRunAt === undefined && (job.trigger.kind === "at" || store.nextRun(job.trigger, this.now) !== null));
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
    for (const job of this.options.store.due(this.now)) {
      if (this.inFlight.has(job.id)) continue;
      if (!this.options.store.claim(job)) continue;
      // Not awaited: one slow `agentTurn` must not hold back every other job's tick. Errors are
      // handled inside `execute`, so nothing escapes here.
      void this.execute(job, "schedule");
    }
  }

  /** Whether a run of this job is going now — what `runNow` would refuse a second start for. */
  isRunning(id: string): boolean {
    return this.inFlight.has(id);
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
  ): Promise<RunOutcome | { status: "unavailable"; result: string }> {
    const job = this.options.store.get(id);
    if (!job) return { status: "unavailable", result: "no such job" };
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
      advanceSchedule: trigger !== undefined && job.trigger.kind === "webhook",
      ...(trigger ? { trigger } : {}),
    });
  }

  private async execute(
    job: Job,
    cause: "schedule" | "manual" | "webhook",
    opts: { advanceSchedule?: boolean; trigger?: TriggerContext } = {},
  ): Promise<RunOutcome> {
    const controller = new AbortController();
    this.inFlight.set(job.id, controller);
    const run = this.options.store.startRun(job.id);
    const startedAt = this.now;

    let outcome: RunOutcome;
    try {
      outcome = await this.dispatch(job, controller.signal, opts.trigger);
    } catch (err) {
      // Anything thrown past `dispatch` is a bug in it, not in the job. Recorded against the job
      // anyway: an unattended run that vanishes without a row is the failure that costs hours.
      outcome = { status: "error", result: toUserMessage(err) };
      log.error("cron run threw", { job: job.id, error: String(err) });
    } finally {
      this.inFlight.delete(job.id);
    }

    this.options.store.finishRun(run.id, outcome);
    if (opts.advanceSchedule !== false) this.options.store.settle(job, outcome);

    const level = outcome.status === "error" ? "warn" : "info";
    log[level]("cron run finished", {
      job: job.id,
      name: job.name,
      status: outcome.status,
      cause,
      duration_ms: this.now - startedAt,
      ...(outcome.result ? { result: outcome.result.slice(0, 300) } : {}),
    });

    // A failed unattended run has to reach a person. The chat the job points at is the one place
    // the operator is already looking, and it is where the successful runs would have gone.
    if (outcome.status === "error") await this.reportFailure(job, outcome);
    return outcome;
  }

  private async dispatch(
    job: Job,
    signal: AbortSignal,
    trigger?: TriggerContext,
  ): Promise<RunOutcome> {
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
        const delivered = await this.deliverResult(job, withDeliveredBody(job.payload.text, trigger));
        return delivered.ok
          ? { status: "success", result: "delivered" }
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
        // Whoever called the endpoint wrote the payload: what the turn keeps after reading it waits for a person (S13).
        const outside = trigger?.body?.trim() ? [WEBHOOK_PAYLOAD] : undefined;

        if (job.delivery.mode === "announce" && runsOnChatHistory(job)) {
          const message = unattendedPreamble(job, prompt);
          if (!this.options.executors.dispatchTurn(job, message, outside)) {
            return { status: "error", result: "the pipeline would not accept the turn" };
          }
          return { status: "success", result: "dispatched" };
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
        const delivered = await this.deliverResult(job, result.text);
        return delivered.ok
          ? { status: "success", result: result.text.slice(0, 2000), ...held }
          : { ...undelivered(delivered), ...held };
      }

      case "mission": {
        /**
         * Long work, as a mission (0.8.0): started and left to run — it survives a restart, parks what needs a person, and
         * ends at the reviewer. The run records which mission it started; that mission's page and its notices in the
         * job's chat say how it went. A run due while the last one still works is skipped, and says so.
         */
        const run = this.options.executors.startMission?.(job, trigger?.body) ?? { refused: "missions are not run in this process" };
        if ("busy" in run) return { status: "skipped", result: `the last run, mission ${run.busy}, is still working` };
        if ("refused" in run) return { status: "error", result: run.refused };
        return { status: "success", result: `started mission ${run.started}` };
      }

      case "command": {
        const sandbox = this.options.executors.commandSandbox(job);
        if (!sandbox) {
          return { status: "error", result: `agent ${job.agentId} is not loaded, so its workspace is unknown` };
        }

        const options: SandboxOptions = {
          cwd: job.payload.cwd ?? sandbox.cwd,
          agent: job.agentId,
          timeoutMs: job.payload.timeoutMs ?? this.options.config.commandTimeoutMs,
          maxOutputBytes: 256 * 1024,
          env: sandbox.env,
        };

        const result = await runCommand(job.payload.argv, options);
        // `secrets` are the credentials the command was handed; they must not come back out in a
        // delivery, a webhook body or the run row.
        const output = maskSecrets(commandOutput(result.stdout, result.stderr), sandbox.secrets ?? {});

        if (result.timedOut) {
          return { status: "error", result: `timed out after ${options.timeoutMs}ms` };
        }
        if (result.exitCode !== 0) {
          return {
            status: "error",
            result: `exit ${result.exitCode}${output ? `\n${output.slice(0, 2000)}` : ""}`,
          };
        }

        /**
         * Nothing printed: nothing to deliver and nothing for the agent to read (PLAN §1.1, 0.8.17). So a check every five
         * minutes that finds nothing costs no turn and sends nothing, `--then agent` too, where it used to wake the agent
         * with an empty output each time. Its run says so. A failure above is not an empty run, and is reported as before.
         */
        if (!output.trim()) {
          return { status: "success", result: job.payload.then === "deliver" ? "exit 0, no output" : "exit 0, no output: the agent was not woken" };
        }

        if (job.payload.then === "deliver") {
          const delivered = await this.deliverResult(job, output);
          return delivered.ok
            ? { status: "success", result: output.slice(0, 2000) }
            : undelivered(delivered);
        }

        // The token-efficient shape: the command has already produced the facts, so the model is
        // asked to do the one thing it is needed for. A turn that had to call `exec` itself would
        // spend two round trips discovering what is already in hand.
        // Same condition as the `agentTurn` case above, and for the same reason: the dispatch path's
        // reply goes to the conversation the message came from, which only reaches a person when
        // that conversation is the target chat.
        if (job.delivery.mode === "announce" && runsOnChatHistory(job)) {
          const message = unattendedPreamble(job, commandTurnMessage(job, output));
          if (!this.options.executors.dispatchTurn(job, message)) {
            return { status: "error", result: "the pipeline would not accept the turn" };
          }
          return { status: "success", result: "dispatched" };
        }
        const turn = await this.runTurn(job, commandTurnMessage(job, output), undefined, signal);
        const held = turn.held?.length ? { held: turn.held } : {};
        if (turn.error) return { status: "error", result: turn.error, ...held };
        if (!turn.text.trim()) return { status: "success", result: "the agent had nothing to report", ...held };
        const delivered = await this.deliverResult(job, turn.text);
        return delivered.ok
          ? { status: "success", result: turn.text.slice(0, 2000), ...held }
          : { ...undelivered(delivered), ...held };
      }
    }
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

  /** Route a run's output according to the job's delivery mode. */
  private async deliverResult(job: Job, text: string): Promise<Delivered> {
    const trimmed =
      text.length > MAX_DELIVERED_CHARS ? `${text.slice(0, MAX_DELIVERED_CHARS)}\n…(truncated)` : text;

    switch (job.delivery.mode) {
      case "none":
        return { ok: true };

      case "webhook": {
        if (!this.options.executors.webhook || !job.delivery.webhookUrl) {
          return { ok: false, error: "webhook delivery is not available on this daemon" };
        }
        try {
          await this.options.executors.webhook(job.delivery.webhookUrl, {
            job: job.id,
            name: job.name,
            agentId: job.agentId,
            firedAt: this.now,
            text: trimmed,
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: `webhook failed: ${toUserMessage(err)}` };
        }
      }

      case "announce": {
        const target = deliveryTarget(job);
        const sent = await this.options.executors.deliver(target, trimmed, { agentId: job.agentId, job: job.name });
        return sent.ok
          ? { ok: true }
          : { ok: false, error: `could not deliver to ${target.gatewayId} ${target.chatId}: ${sent.reason}`, unreachable: true };
      }
    }
  }

  /**
   * Tell somebody the job failed.
   *
   * Best-effort and never allowed to throw: this runs inside the error path, and a failure alert
   * that fails must not replace the failure it was reporting on. Suppressed for `none` delivery —
   * a job explicitly told to stay quiet does not get to be loud only when it breaks.
   *
   * Not into a chat that has just refused the run's own delivery: the notice was refused the same way, one more call
   * and one more error line for nobody. That failure goes to the daemon's alert channel, which is where an operator
   * hears that something unattended stopped working — once per job per cooldown, not once per run.
   */
  private async reportFailure(job: Job, outcome: Extract<RunOutcome, { status: "error" }>): Promise<void> {
    if (job.delivery.mode === "none") return;
    const detail = outcome.result.slice(0, 1000);
    try {
      if (outcome.unreachable) {
        await this.options.executors.alert?.(`cron_unreachable:${job.id}`, `Scheduled job "${job.name}" failed: ${detail}`);
        return;
      }
      await this.options.executors.deliver(
        deliveryTarget(job),
        `Scheduled job **${job.name}** failed.\n${detail}`,
      );
    } catch (err) {
      log.warn("cron failure notice could not be delivered", { job: job.id, error: String(err) });
    }
  }
}

/** stdout when there is any, stderr when there is not, both when both — labelled so they are legible. */
function commandOutput(stdout: string, stderr: string): string {
  const out = stdout.trim();
  const err = stderr.trim();
  if (out && err) return `stdout:\n${out}\n\nstderr:\n${err}`;
  return out || err;
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
