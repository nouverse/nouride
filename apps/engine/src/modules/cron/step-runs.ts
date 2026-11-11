/**
 * A run of several steps, as the scheduler keeps it going (`steps.ts` runs it): started, stopped to wait, and taken up
 * again when the mission it waits for ends or a person answers.
 *
 * A waiting run holds nothing in memory and no place in the scheduler's list of runs at work. It is a row
 * (`runs.store.ts`), and each thing that can end its wait finds it there: a mission's end, an answer from a chat or the
 * dashboard, the time it was given running out, and the boot, which asks after the missions that ended while the
 * daemon was down. Its job is not due again meanwhile: a claimed job has no next time until its run settles it.
 */

import { createLogger, toUserMessage, type Job, type JobRun, type JobStep, type RunWait } from "@nouride/shared";
import type { CronPort, RunOutcome, RunState } from "./cron.store.ts";
import { answeredCard, type AskAnswered } from "./step-asks.ts";
import { runSteps, stepLabel, type StepHands, type StepsEnd, type Woke } from "./steps.ts";
import type { TriggerContext } from "./scheduler.ts";
import type { MissionEnd } from "@/modules/missions/job-runs.ts";

const log = createLogger("cron.steps");

/** A run that stopped to wait: not an end, so nothing is settled or reported yet. */
export interface Parked {
  status: "waiting";
  result: string;
}

export interface StepRunsDeps {
  store: CronPort;
  /** What a run's steps are done with (`CronScheduler.stepHands`). */
  hands(job: Job, signal: AbortSignal, runId: string): StepHands;
  /** The job's place among the runs at work: taken (null when a run of it is going) and given back. */
  enter(jobId: string): AbortController | null;
  leave(jobId: string): void;
  /** A run over: written down, its job settled when the run counts for it, a failure told. */
  ended(job: Job, runId: string, outcome: RunOutcome, settles: boolean): Promise<void>;
  /** How a mission stands, or null when there is none by that id. Absent where missions are not run. */
  mission?(id: string): MissionEnd | null;
  /** A question's card rewritten, when it was answered somewhere else or not at all. */
  settleCard?(card: NonNullable<RunState["card"]>, text: string): void;
  now(): number;
}

/** What a waiting run waits for, in words for its job's page and the run's row. */
function waitWords(job: Pick<Job, "agentId">, steps: readonly JobStep[], wait: RunWait): string {
  const index = steps.findIndex((step) => step.id === wait.step);
  const at = index >= 0 ? stepLabel(job, steps[index]!, index, steps.length) : "a step";
  return wait.kind === "mission" ? `waiting at ${at}: mission ${wait.missionId} is at work` : `waiting at ${at}: for a person's answer`;
}

export class StepRuns {
  constructor(private readonly deps: StepRunsDeps) {}

  /** A run begun: its end, or the wait it stopped at. */
  async begin(job: Job, run: Pick<JobRun, "id">, signal: AbortSignal, trigger: TriggerContext | undefined, settles: boolean): Promise<RunOutcome | Parked> {
    if (job.payload.kind !== "steps") return { status: "error", result: "not a job of steps" };
    const end = await runSteps(job, job.payload.steps, this.deps.hands(job, signal, run.id), trigger ? { trigger } : {});
    return this.keep(job, run.id, end, settles);
  }

  private keep(job: Job, runId: string, end: StepsEnd, settles: boolean): RunOutcome | Parked {
    if ("outcome" in end) return end.outcome;
    this.deps.store.parkRun(runId, { ...end.park, settles }, end.outcomes);
    const result = waitWords(job, job.payload.kind === "steps" ? job.payload.steps : [], end.park.wait);
    log.info("a run waits", { job: job.id, run: runId, for: end.park.wait.kind, step: end.park.wait.step });
    return { status: "waiting", result };
  }

  /** Whether a run of this job waits: its job starts no other until that one is over. */
  waitingOf(jobId: string): { runId: string; wait: RunWait } | null {
    const found = this.deps.store.waitingRuns().find((one) => one.run.jobId === jobId);
    return found ? { runId: found.run.id, wait: found.state.wait } : null;
  }

  /** A waiting run taken up again with what ended its wait. Nothing when it no longer waits. */
  async wake(runId: string, woke: Woke): Promise<void> {
    const waiting = this.deps.store.waitingRun(runId);
    if (!waiting) return;
    const { run, state } = waiting;
    const job = this.deps.store.get(run.jobId);
    if (!job || job.payload.kind !== "steps") {
      this.deps.store.finishRun(runId, { status: "interrupted", result: "its job was removed or changed into one thing while the run waited", ...(run.steps ? { steps: run.steps } : {}) });
      return;
    }
    const controller = this.deps.enter(job.id);
    // Two things ended one wait at once: the first has it.
    if (!controller) return;
    this.deps.store.unparkRun(runId);

    let end: StepsEnd;
    try {
      end = await runSteps(job, job.payload.steps, this.deps.hands(job, controller.signal, runId), { state, outcomes: run.steps ?? [], woke });
    } catch (err) {
      log.error("a waiting run threw as it went on", { job: job.id, run: runId, error: String(err) });
      end = { outcome: { status: "error", result: toUserMessage(err), ...(run.steps ? { steps: run.steps } : {}) } };
    } finally {
      this.deps.leave(job.id);
    }
    const kept = this.keep(job, runId, end, state.settles);
    if (kept.status !== "waiting") await this.deps.ended(job, runId, kept, state.settles);
  }

  /** A mission ended or changed: a run that waits for it goes on once it is over. */
  missionChanged(missionId: string): void {
    const waiting = this.deps.store.waitingRuns().find((one) => one.state.wait.kind === "mission" && one.state.wait.missionId === missionId);
    if (!waiting) return;
    const end = this.deps.mission?.(missionId);
    if (end && "working" in end) return;
    void this.wake(waiting.run.id, missionWoke(end ?? null));
  }

  /**
   * A person's answer to a step that waits for one, from a chat's button or the dashboard. The run goes on behind this:
   * the steps after it may take as long as they take.
   */
  answer(runId: string, go: boolean, by: string, via: "chat" | "dashboard"): AskAnswered {
    const waiting = this.deps.store.waitingRun(runId);
    const job = waiting ? this.deps.store.get(waiting.run.jobId) : null;
    if (!waiting || !job || waiting.state.wait.kind !== "approval") return { refused: "That is not waiting any more.", settled: "⌛ No longer waiting." };
    const settled = answeredCard(job, waiting.state.wait.ask, go ? `✅ ${by} said to continue.` : `🛑 Stopped by ${by}.`);
    // A press rewrites its own card with what this answers; one from the dashboard has the card follow.
    if (via === "dashboard" && waiting.state.card) this.deps.settleCard?.(waiting.state.card, settled);
    log.info("a waiting step answered", { job: job.id, run: runId, go, via });
    void this.wake(runId, go ? { kind: "approval", go: true, by } : { kind: "approval", go: false, by });
    return { ok: true, settled };
  }

  /** The soonest a waiting step runs out of time, for the scheduler's timer. */
  nextDeadline(): number | null {
    let next: number | null = null;
    for (const { state } of this.deps.store.waitingRuns()) {
      if (state.wait.kind === "approval" && (next === null || state.wait.until < next)) next = state.wait.until;
    }
    return next;
  }

  /** Steps nobody answered in time: each one's run goes on by its failed exit, which by default ends it. */
  expire(): void {
    const now = this.deps.now();
    for (const { run, state } of this.deps.store.waitingRuns()) {
      if (state.wait.kind !== "approval" || state.wait.until > now) continue;
      const job = this.deps.store.get(run.jobId);
      if (state.card && job) this.deps.settleCard?.(state.card, answeredCard(job, state.wait.ask, "⌛ Nobody answered in time, so it stopped there."));
      void this.wake(run.id, { kind: "approval", go: false });
    }
  }

  /**
   * At boot: the runs that waited across the restart. One whose mission ended while the daemon was down, or is gone,
   * goes on now; one whose mission still works, or that waits for a person, goes on waiting.
   */
  recover(): void {
    const waiting = this.deps.store.waitingRuns();
    for (const { run, state } of waiting) {
      if (state.wait.kind !== "mission" || !this.deps.mission) continue;
      const end = this.deps.mission(state.wait.missionId);
      if (end && "working" in end) continue;
      void this.wake(run.id, missionWoke(end));
    }
    if (waiting.length > 0) log.info("runs that waited across the restart", { runs: waiting.length });
  }
}

function missionWoke(end: Exclude<MissionEnd, { working: true }> | null): Woke {
  if (!end) return { kind: "mission", failed: "its mission is gone" };
  return "said" in end ? { kind: "mission", said: end.said } : { kind: "mission", failed: end.failed };
}
