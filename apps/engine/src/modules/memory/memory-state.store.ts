/**
 * What memory knows that its files do not (`069_baseline.sql`): which episodes the nightly pass failed
 * to file, the pass's own runs, and what changed in memory and why. Where each chat was last cut is not
 * here: the vault says it (`run.ts:cutChat`).
 *
 * Kept apart from the index on purpose. The index is a cache a reindex empties; these are state, and
 * a reindex must not reset them — though losing them costs little: a lost attempt count retries an episode.
 */

import { randomHex, type SqliteDb } from "@nouride/runtime";
import type { ChangeCause, ChangeKind, MemoryChange } from "./changes.ts";
import type { Port } from "@nouride/shared";

/** Runs kept: enough for "what did the last few nights do", never a growing log. */
const RUNS_KEPT = 30;
/** Starts of one night's scheduled pass without a finish before the night is given up on. */
const STARTS_PER_NIGHT = 2;
/** Changes kept: long enough to notice a wrong one, short enough not to grow for good. */
const CHANGES_KEPT_MS = 90 * 86_400_000;

interface ChangeRow {
  at: number;
  subject: string;
  change: ChangeKind;
  text: string;
  previous: string | null;
  source: string | null;
  cause: ChangeCause;
  secondhand: number;
}

export interface PassRun {
  startedAt: number;
  day: string;
  scheduled: boolean;
  finishedAt: number | null;
  /** The run's report, once it finished. */
  report: unknown;
}

export class MemoryStateStore {
  constructor(private readonly db: SqliteDb) {}

  attempts(episodeId: string): number {
    return this.db.prepare<{ attempts: number }>("SELECT attempts FROM memory_attempts WHERE episode_id = ?").get(episodeId)?.attempts ?? 0;
  }

  recordFailure(episodeId: string, error: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO memory_attempts (episode_id, attempts, last_error, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT (episode_id) DO UPDATE SET attempts = memory_attempts.attempts + 1, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(episodeId, error, now);
  }

  clearAttempts(episodeId?: string): void {
    if (episodeId) this.db.prepare("DELETE FROM memory_attempts WHERE episode_id = ?").run(episodeId);
    else this.db.prepare("DELETE FROM memory_attempts").run();
  }

  /** Episodes tried at least `atLeast` times — those the pass has given up on, for a person to see. */
  failed(atLeast: number): { episodeId: string; attempts: number; lastError: string | null }[] {
    return this.db
      .prepare<{ episode_id: string; attempts: number; last_error: string | null }>(
        "SELECT episode_id, attempts, last_error FROM memory_attempts WHERE attempts >= ? ORDER BY updated_at DESC",
      )
      .all(atLeast)
      .map((row) => ({ episodeId: row.episode_id, attempts: row.attempts, lastError: row.last_error }));
  }

  /** A run begins; its id. Recorded at the start, so a night cut short by a restart is resumed once, not endlessly — see `lastScheduledDay`. */
  passStarted(run: { startedAt: number; day: string; scheduled: boolean }): string {
    const id = randomHex(8);
    this.db.prepare("INSERT INTO memory_pass_runs (id, started_at, day, scheduled) VALUES (?, ?, ?, ?)").run(id, run.startedAt, run.day, run.scheduled ? 1 : 0);
    this.db.prepare("DELETE FROM memory_pass_runs WHERE id NOT IN (SELECT id FROM memory_pass_runs ORDER BY started_at DESC LIMIT ?)").run(RUNS_KEPT);
    return id;
  }

  passFinished(id: string, finishedAt: number, report: unknown): void {
    this.db.prepare("UPDATE memory_pass_runs SET finished_at = ?, report = ? WHERE id = ?").run(finishedAt, JSON.stringify(report), id);
  }

  /**
   * The last day the scheduled pass is done for, or null when none is.
   *
   * Done means it finished — not that it started. Counting a start as done lost a whole night on the
   * live box: the pass began at 01:00:09, a deploy restarted the daemon fifty seconds later, and the
   * night was marked run with nothing filed. A night that has started `STARTS_PER_NIGHT` times and never
   * finished is done too, so a pass that takes the daemon down with it is not retried on every boot.
   */
  lastScheduledDay(): string | null {
    return (
      this.db
        .prepare<{ day: string }>(
          "SELECT day FROM memory_pass_runs WHERE scheduled = 1 GROUP BY day HAVING MAX(CASE WHEN finished_at IS NOT NULL THEN 1 ELSE 0 END) = 1 OR COUNT(*) >= ? ORDER BY MAX(started_at) DESC LIMIT 1",
        )
        .get(STARTS_PER_NIGHT)?.day ?? null
    );
  }

  /** Whether the scheduled pass has any record at all — the first boot of an install has none. */
  hasScheduledRun(): boolean {
    return this.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM memory_pass_runs WHERE scheduled = 1").get()!.n > 0;
  }

  /** A night marked done without running — the first boot after the pass time. No report: nothing ran. */
  passSkipped(run: { at: number; day: string }): void {
    this.db.prepare("INSERT INTO memory_pass_runs (id, started_at, day, scheduled, finished_at) VALUES (?, ?, ?, 1, ?)").run(randomHex(8), run.at, run.day, run.at);
  }

  /** The last run that finished, scheduled or not. */
  lastFinishedRun(): PassRun | null {
    const row = this.db
      .prepare<{ started_at: number; day: string; scheduled: number; finished_at: number; report: string }>(
        "SELECT started_at, day, scheduled, finished_at, report FROM memory_pass_runs WHERE report IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get();
    return row ? { startedAt: row.started_at, day: row.day, scheduled: row.scheduled === 1, finishedAt: row.finished_at, report: JSON.parse(row.report) as unknown } : null;
  }

  /** Record what changed, and forget what is past the window. */
  recordChanges(changes: readonly MemoryChange[]): void {
    if (changes.length === 0) return;
    const insert = this.db.prepare("INSERT INTO memory_changes (id, at, subject, change, text, previous, source, cause, secondhand) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    this.db.transaction(() => {
      for (const change of changes) insert.run(randomHex(8), change.at, change.subject, change.change, change.text, change.previous ?? null, change.source ?? null, change.cause, change.secondhand ? 1 : 0);
      this.db.prepare("DELETE FROM memory_changes WHERE at < ?").run(Math.max(...changes.map((change) => change.at)) - CHANGES_KEPT_MS);
    });
  }

  /**
   * Forget changes past the window — the daily retention sweep's. Pruning only when a change was recorded kept every
   * change a quiet install ever had: with nothing new written, the 90 days never came round.
   */
  sweepChanges(now: number = Date.now()): number {
    return this.db.prepare("DELETE FROM memory_changes WHERE at < ?").run(now - CHANGES_KEPT_MS).changes;
  }

  /**
   * What is recorded about deleted conversations, and about a person being forgotten: the changes their
   * facts made, and the pass's failed attempts at those conversations. Kept, Recent changes went on showing
   * a forgotten person's facts word for word for 90 days, and Gave up listed conversations that were gone.
   */
  forget(what: { subject?: string; episodes?: readonly string[] }): void {
    const episodes = JSON.stringify(what.episodes ?? []);
    this.db.transaction(() => {
      if (what.subject !== undefined) this.db.prepare("DELETE FROM memory_changes WHERE subject = ?").run(what.subject);
      this.db.prepare("DELETE FROM memory_changes WHERE source IN (SELECT value FROM json_each(?))").run(episodes);
      this.db.prepare("DELETE FROM memory_attempts WHERE episode_id IN (SELECT value FROM json_each(?))").run(episodes);
    });
  }

  /** Newest first, optionally one subject's. */
  changes(filter: { subject?: string; limit: number }): MemoryChange[] {
    const rows = filter.subject
      ? this.db.prepare<ChangeRow>("SELECT at, subject, change, text, previous, source, cause, secondhand FROM memory_changes WHERE subject = ? ORDER BY at DESC LIMIT ?").all(filter.subject, filter.limit)
      : this.db.prepare<ChangeRow>("SELECT at, subject, change, text, previous, source, cause, secondhand FROM memory_changes ORDER BY at DESC LIMIT ?").all(filter.limit);
    return rows.map((row) => ({
      at: row.at,
      subject: row.subject,
      change: row.change,
      text: row.text,
      ...(row.previous !== null ? { previous: row.previous } : {}),
      ...(row.source !== null ? { source: row.source } : {}),
      cause: row.cause,
      ...(row.secondhand === 1 ? { secondhand: true as const } : {}),
    }));
  }
}

export type MemoryStatePort = Port<MemoryStateStore>;
