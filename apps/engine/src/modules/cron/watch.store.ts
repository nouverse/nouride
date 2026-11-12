/**
 * What an automation that watches keeps between runs (`cron_step_said`, `cron_held`), apart from the job table: a hash
 * of what each step marked to go on only when changed last said, and what was held for the install's quiet hours.
 *
 * Neither is a run's record. A hash is the one thing a later run reads of an earlier one, and it is not the text. A
 * held line is a message on its way, deleted the moment it is sent.
 */

import type { SqliteDb } from "@nouride/runtime";

/** What a held line is: a run's words, why a run failed, or a question a step waits on. */
export type HeldKind = "said" | "failed" | "ask";

export interface HeldLine {
  id: number;
  jobId: string;
  runId?: string;
  stepId?: string;
  kind: HeldKind;
  text: string;
  at: number;
}

interface HeldRow {
  id: number;
  job_id: string;
  run_id: string | null;
  step_id: string | null;
  kind: string;
  text: string;
  at: number;
}

export class WatchStore {
  constructor(private readonly db: SqliteDb, private readonly now: () => number = Date.now) {}

  /** What the step said the last time a run of its job ended well, as a hash; nothing before its first. */
  saidBefore(jobId: string, stepId: string): string | undefined {
    return this.db.prepare<{ hash: string }>("SELECT hash FROM cron_step_said WHERE job_id = ? AND step_id = ?").get(jobId, stepId)?.hash;
  }

  /** What a run's marked steps said, kept as what the next run compares with. */
  keepSaid(jobId: string, said: Readonly<Record<string, string>>): void {
    const keep = this.db.prepare("INSERT INTO cron_step_said (job_id, step_id, hash, at) VALUES (?, ?, ?, ?) ON CONFLICT (job_id, step_id) DO UPDATE SET hash = excluded.hash, at = excluded.at");
    for (const [stepId, hash] of Object.entries(said)) keep.run(jobId, stepId, hash, this.now());
  }

  /** One line kept for when the quiet hours end. */
  hold(line: { jobId: string; runId?: string; stepId?: string; kind: HeldKind; text: string }): void {
    this.db.prepare("INSERT INTO cron_held (job_id, run_id, step_id, kind, text, at) VALUES (?, ?, ?, ?, ?, ?)").run(line.jobId, line.runId ?? null, line.stepId ?? null, line.kind, line.text, this.now());
  }

  /** Whether anything waits to be said. */
  holding(): boolean {
    return this.db.prepare<{ n: number }>("SELECT count(*) AS n FROM cron_held").get()!.n > 0;
  }

  /** Everything held, in the order it was said, taken out: sent or lost, it is not sent twice. */
  release(): HeldLine[] {
    const rows = this.db.prepare<HeldRow>("SELECT id, job_id, run_id, step_id, kind, text, at FROM cron_held ORDER BY at, id").all();
    if (rows.length > 0) this.db.prepare("DELETE FROM cron_held WHERE id <= ?").run(rows[rows.length - 1]!.id);
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      ...(row.step_id === null ? {} : { stepId: row.step_id }),
      kind: row.kind as HeldKind,
      text: row.text,
      at: row.at,
    }));
  }
}
