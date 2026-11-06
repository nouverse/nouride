/**
 * Classes of work seen once, held until they recur (`069_baseline.sql`).
 *
 * A skill is a procedure for work that comes back, and one conversation cannot show that. So a create from the pass is
 * a candidate first: its name, its "Use when" line and why. The skill is written when another conversation is the same
 * class of work — by the name, or by the candidate the pass says it recurs — and a person asking for a skill skips the
 * wait. A candidate that does not come back in `HELD_DAYS` lapses.
 */

import type { SqliteDb } from "@nouride/runtime";

/** How long a class of work seen once waits for a second conversation. */
const HELD_DAYS = 30;
const DAY_MS = 86_400_000;

export interface SkillCandidate {
  name: string;
  description: string;
  why: string;
  agentId: string;
  sessionId: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface Row {
  name: string;
  description: string;
  why: string;
  agent_id: string;
  session_id: string;
  first_seen_at: number;
  last_seen_at: number;
}

const fromRow = (row: Row): SkillCandidate => ({
  name: row.name,
  description: row.description,
  why: row.why,
  agentId: row.agent_id,
  sessionId: row.session_id,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
});

export class CandidateStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every candidate still held, newest first; those past `HELD_DAYS` are dropped on the way. */
  list(): SkillCandidate[] {
    this.db.prepare("DELETE FROM skill_candidates WHERE last_seen_at < ?").run(this.now() - HELD_DAYS * DAY_MS);
    return this.db.prepare<Row>("SELECT * FROM skill_candidates ORDER BY last_seen_at DESC").all().map(fromRow);
  }

  /**
   * The candidate this create is a second sighting of: the one it names in `recurs`, else one of the same name — and
   * only when it was seen in another conversation. The same conversation going on is not the work coming back.
   */
  recurring(create: { name: string; recurs?: string }, sessionId: string): SkillCandidate | null {
    const held = this.list();
    const match = held.find((candidate) => candidate.name === create.recurs) ?? held.find((candidate) => candidate.name === create.name);
    return match && match.sessionId !== sessionId ? match : null;
  }

  /** Hold a class of work seen once. A name already held keeps its first sighting and takes the newer wording. */
  hold(candidate: { name: string; description: string; why: string; agentId: string; sessionId: string }): void {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO skill_candidates (name, description, why, agent_id, session_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET description = excluded.description, why = excluded.why, last_seen_at = excluded.last_seen_at`,
      )
      .run(candidate.name, candidate.description, candidate.why, candidate.agentId, candidate.sessionId, at, at);
  }

  /** Done with: its skill is being written. */
  take(name: string): void {
    this.db.prepare("DELETE FROM skill_candidates WHERE name = ?").run(name);
  }
}
