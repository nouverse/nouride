/**
 * The history of a job's runs (`cron_runs`): each one started and ended, how its steps went, and, for a run that
 * stopped to wait for a mission or a person, where it stands.
 *
 * Apart from the job table (`cron.store.ts`), which owns when a job is next due and nothing about a run. A waiting run
 * is the one row here that is neither over nor at work: it has no `finished_at`, its status is `waiting`, and `state`
 * holds what going on needs. A restart reads it from here, so nothing a waiting run needs is in memory.
 */

import { createLogger, newId, type HeldAction, type JobRun, type RunWait, type StepOutcome } from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";

const log = createLogger("cron.runs");

/** How a run ended. */
export type RunOutcome = (
  | { status: "success"; result?: string }
  | {
      status: "error";
      result: string;
      /** The job's own chat would not take its delivery — so a failure notice sent there would not arrive either. */
      unreachable?: true;
    }
  | { status: "skipped"; result: string }
  | { status: "interrupted"; result: string }
) & {
  /** What its guards held with nobody there to ask, kept on the run for a person to allow always. */
  held?: readonly HeldAction[];
  /** How each step went, for a job of several: as many as were reached. */
  steps?: readonly StepOutcome[];
  /** What each step marked `onlyChanged` said, as a hash by its id: what the job's next run compares with. */
  said?: Readonly<Record<string, string>>;
  /** The run told somebody something: its words were delivered, or a mission it started reports for itself. */
  told?: true;
};

interface RunRow {
  id: string;
  job_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  result: string | null;
  held: string | null;
  steps: string | null;
  state: string | null;
}

/** Where a run of several steps stands while it waits: what going on needs, and all of it. */
export interface RunState {
  /** The id of the step it waits in. */
  at: string;
  wait: RunWait;
  /** What the step before said, to hand on. `told`: the chat heard it already, so the run's end does not repeat it. */
  before?: { from: string; said: string; failed?: true; told?: true };
  /** A webhook's body no step has read yet. */
  body?: string;
  /** The run read a webhook's payload: what a later turn keeps waits for a person. */
  outside?: true;
  /** What the run's guards held so far. */
  held?: HeldAction[];
  /** What each step marked `onlyChanged` said so far, as a hash by its id: kept on the job once the run ends well. */
  said?: Record<string, string>;
  /** The run told its chat something already. */
  told?: true;
  /** The card a person was asked on, to rewrite once it is answered, from wherever. */
  card?: { gatewayId: string; chatId: string; messageId: string };
  /** Whether the run's end counts for its job and moves its schedule: one forced by hand does neither. */
  settles: boolean;
  /** A person started it by hand: they are there, so nothing it says is held for the quiet hours. */
  byHand?: true;
}

/** A run that waits, with what it waits in. */
export interface WaitingRun {
  run: JobRun;
  state: RunState;
}

export class RunHistory {
  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number,
  ) {}

  start(jobId: string): JobRun {
    const run: JobRun = { id: newId("run"), jobId, startedAt: this.now(), status: "success" };
    /**
     * The job's name is copied onto the run, not joined to it later.
     *
     * A one-shot is deleted the moment it fires, so by the time anybody reads its history the row it
     * would have joined to is gone — that is how every successful `at` job used to vanish from the
     * run list entirely. Copied *at start* rather than at finish, so a run that is still going has a
     * name too, and a job renamed between two runs reads as two names, which is what happened.
     */
    const name = this.db.prepare<{ name: string }>("SELECT name FROM cron_jobs WHERE id = ?").get(jobId)?.name;
    this.db
      .prepare("INSERT INTO cron_runs (id, job_id, job_name, started_at, finished_at, status, result) VALUES (?, ?, ?, ?, NULL, 'running', NULL)")
      .run(run.id, run.jobId, name ?? null, run.startedAt);
    return run;
  }

  finish(runId: string, outcome: RunOutcome): void {
    this.db
      .prepare("UPDATE cron_runs SET finished_at = ?, status = ?, result = ?, held = ?, steps = ?, state = NULL WHERE id = ?")
      .run(this.now(), outcome.status, outcome.result ?? null, outcome.held?.length ? JSON.stringify(outcome.held) : null, outcome.steps?.length ? JSON.stringify(outcome.steps) : null, runId);
  }

  /** Only a run that is not over: a write that lost a race with its end must not bring a step back to "running". */
  progress(runId: string, steps: readonly StepOutcome[]): void {
    this.db.prepare("UPDATE cron_runs SET steps = ? WHERE id = ? AND finished_at IS NULL").run(JSON.stringify(steps), runId);
  }

  park(runId: string, state: RunState, steps: readonly StepOutcome[]): void {
    this.db.prepare("UPDATE cron_runs SET status = 'waiting', state = ?, steps = ? WHERE id = ? AND finished_at IS NULL").run(JSON.stringify(state), JSON.stringify(steps), runId);
  }

  /** Taken up again: at work, its state kept until it ends or waits anew, so a crash now reads as interrupted. */
  unpark(runId: string): void {
    this.db.prepare("UPDATE cron_runs SET status = 'running' WHERE id = ? AND status = 'waiting'").run(runId);
  }

  waiting(): WaitingRun[] {
    return this.db
      .prepare<RunRow>("SELECT * FROM cron_runs WHERE status = 'waiting' AND finished_at IS NULL AND state IS NOT NULL ORDER BY started_at ASC")
      .all()
      .map((row) => ({ run: toRun(row), state: JSON.parse(row.state as string) as RunState }));
  }

  of(jobId: string, limit: number): JobRun[] {
    return this.db.prepare<RunRow>("SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?").all(jobId, limit).map(toRun);
  }

  /**
   * Recent runs across every job, newest first, with the job's name attached.
   *
   * `of(jobId)` answers "how has this one been doing", which is the question a job's own page asks. This answers "what
   * has fired lately", which is the question you ask when something went wrong and you do not yet know which job it
   * was — and it was not answerable at all without opening every job in turn.
   */
  recent(limit: number): (JobRun & { jobName: string; agentId: string })[] {
    return this.db
      .prepare<RunRow & { job_name: string | null; agent_id: string | null }>(
        // `r.job_name` first, because the join cannot answer for a job that has been deleted — and a
        // successfully fired one-shot always has been. The join is still there for `agent_id`, which
        // is genuinely the job's rather than the run's.
        `SELECT r.*, COALESCE(r.job_name, j.name) AS job_name, j.agent_id AS agent_id
         FROM cron_runs r LEFT JOIN cron_jobs j ON j.id = r.job_id
         ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500)))
      .map((row) => ({
        ...toRun(row),
        // A run whose job has since been deleted keeps its history — the row is the record that it
        // happened, and dropping it would make the list disagree with the audit log.
        jobName: row.job_name ?? "(deleted job)",
        agentId: row.agent_id ?? "",
      }));
  }

  /** Drop run history past the retention window. `0` days keeps everything. A run that waits is not history yet. */
  sweep(days: number): number {
    if (days <= 0) return 0;
    const cutoff = this.now() - days * 86_400_000;
    const removed = this.db.prepare("DELETE FROM cron_runs WHERE started_at < ? AND status != 'waiting'").run(cutoff).changes;
    if (removed > 0) log.info("swept cron run history", { removed, older_than_days: days });
    return removed;
  }

  /**
   * Mark runs left mid-flight by a restart.
   *
   * A row that says `running` with no `finished_at` and no process behind it is a lie the dashboard would render as a
   * job still working. Called once at boot, before the ticker starts. A run that waits was not at work when the
   * process went: it is left as it is, and goes on when what it waits for ends.
   */
  reconcileInterrupted(): number {
    return this.db
      .prepare("UPDATE cron_runs SET status = 'interrupted', finished_at = ?, result = 'interrupted by a daemon restart', state = NULL WHERE finished_at IS NULL AND status != 'waiting'")
      .run(this.now()).changes;
  }
}

function toRun(row: RunRow): JobRun {
  const waiting = row.status === "waiting" && row.state !== null ? (JSON.parse(row.state) as RunState).wait : undefined;
  return {
    id: row.id,
    jobId: row.job_id,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    status: row.status as JobRun["status"],
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.held === null ? {} : { held: JSON.parse(row.held) as HeldAction[] }),
    ...(row.steps === null ? {} : { steps: JSON.parse(row.steps) as StepOutcome[] }),
    ...(waiting ? { waiting } : {}),
  };
}
