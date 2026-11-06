/**
 * Whether a finished job's result reached its agent — the one fact about a wake-up that has to survive
 * a restart (`069_baseline.sql`).
 *
 * Kept apart from `JobStore`, which owns the rest of the row: this is the wake-up's bookkeeping, read at
 * one moment (boot) and written at one other (a wake-up taken from the queue).
 */

import type { SqliteDb } from "@nouride/runtime";
import type { Port } from "@nouride/shared";

export class JobWakeStore {
  constructor(private readonly db: SqliteDb) {}

  /** The wake-up for this job has been taken: its result is in front of the agent. Only the first counts. */
  markWoken(jobId: string, at: number): void {
    this.db.prepare("UPDATE jobs SET woke_at = ? WHERE id = ? AND woke_at IS NULL").run(at, jobId);
  }

  /**
   * Jobs that finished since `since` and never woke their agent — a wake-up lost to a restart.
   *
   * `interrupted` is not here: a job the restart itself killed is reported by `reportInterrupted`, and
   * listing it again would tell the agent twice.
   */
  unwoken(since: number, limit: number): string[] {
    return this.db
      .prepare<{ id: string }>(
        `SELECT id FROM jobs
          WHERE woke_at IS NULL AND ended_at >= ? AND status IN ('succeeded', 'failed', 'killed')
          ORDER BY ended_at DESC LIMIT ?`,
      )
      .all(since, limit)
      .map((row) => row.id);
  }
}

export type JobWakePort = Port<JobWakeStore>;
