/**
 * When the weekly review of the skill library ran, and what it proposed (`069_baseline.sql`, `curator.ts`).
 */

import type { SqliteDb } from "@nouride/runtime";
import type { ReviewReport } from "./curator.ts";

export class ReviewStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** The latest review, or null before the first. */
  last(): { ranAt: number; report: ReviewReport } | null {
    const row = this.db.prepare<{ ran_at: number; report: string }>("SELECT ran_at, report FROM skill_reviews ORDER BY ran_at DESC LIMIT 1").get();
    if (!row) return null;
    try {
      return { ranAt: row.ran_at, report: JSON.parse(row.report) as ReviewReport };
    } catch {
      return { ranAt: row.ran_at, report: { tighten: [], merge: [], archive: [], declined: [] } };
    }
  }

  record(report: ReviewReport): void {
    this.db
      .prepare("INSERT INTO skill_reviews (ran_at, report) VALUES (?, ?) ON CONFLICT (ran_at) DO UPDATE SET report = excluded.report")
      .run(this.now(), JSON.stringify(report));
  }
}
