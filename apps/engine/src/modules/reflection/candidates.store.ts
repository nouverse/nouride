/**
 * Classes of work seen once, held until they recur (`069_baseline.sql`).
 *
 * A skill is a procedure for work that comes back, and one look cannot show that. So a create from the pass is a
 * candidate first: its name, its "Use when" line and why. The skill is written when the same class of work is seen
 * again — by the name, or by the candidate the pass says it recurs — and a person asking for a skill skips the wait. A
 * candidate that does not come back in `HELD_DAYS` lapses.
 *
 * ## The same chat, after a break
 *
 * A conversation is a chat, and a chat does not end: somebody who talks to their agent in one direct message has one
 * conversation for as long as the install lives. Held to "another conversation" alone, their work never came back. On
 * a live box over fifteen days, 44 of 45 creates were held and one skill was written: one class of work was held
 * twelve times across a week in one chat, another eleven times, a third nine.
 *
 * So the same chat counts too, once the work was put down and picked up again: `SAME_CHAT_BREAK_MS` since it was
 * last seen there. Sightings minutes apart are one sitting, which is what "the same conversation going on" meant.
 *
 * ## The third sighting, break or none
 *
 * The break alone still left the person who works in one chat all day without their skill, the day it shipped: one
 * class of work was seen there five times and held five times, the one gap between two sittings being
 * five hours forty, and each sighting moved the clock. Three looks that each named the same new class are the work
 * coming back, whatever the clock says: a look is made after rounds of real work, twice as many after one that kept
 * nothing. Replayed over that box's fifteen days, ten classes held: the five seen more than once are each written
 * at their third sighting, from thirty-six minutes to three and a half days after the first, where the break alone
 * wrote four of them, a day to three and a half days after, and never the fifth. The five seen once stay held.
 */

import type { SqliteDb } from "@nouride/runtime";

/** How long a class of work seen once waits to be seen again. */
const HELD_DAYS = 30;
const DAY_MS = 86_400_000;
/**
 * How long a class of work was not seen in a chat before seeing it there again is the work coming back. A choice, not
 * a measurement: of that box's 32 gaps between two sightings of one class in one chat, 25 were under two hours (one
 * sitting), six over fourteen (another day), and one was seven and a half.
 */
const SAME_CHAT_BREAK_MS = 6 * 3_600_000;
/** The sighting at which a class of work is written whatever the time since the one before: see the header. */
const WRITTEN_AT_SIGHTING = 3;

export interface SkillCandidate {
  name: string;
  description: string;
  why: string;
  agentId: string;
  sessionId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** How many passes named it, the first included. */
  sightings: number;
}

interface Row {
  name: string;
  description: string;
  why: string;
  agent_id: string;
  session_id: string;
  first_seen_at: number;
  last_seen_at: number;
  sightings: number;
}

const fromRow = (row: Row): SkillCandidate => ({
  name: row.name,
  description: row.description,
  why: row.why,
  agentId: row.agent_id,
  sessionId: row.session_id,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  sightings: row.sightings,
});

/** Whether the next look that names this class writes its skill whatever the clock says: what a person is told. */
export const writtenNextSighting = (candidate: Pick<SkillCandidate, "sightings">): boolean => candidate.sightings + 1 >= WRITTEN_AT_SIGHTING;

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
   * The candidate this create is another sighting of, when that makes it the work coming back: the one it names in
   * `recurs`, else one of the same name, seen in another conversation, or in this one before a break, or twice
   * already. A second look in the same sitting is not the work coming back.
   */
  recurring(create: { name: string; recurs?: string }, sessionId: string): SkillCandidate | null {
    const held = this.list();
    const match = held.find((candidate) => candidate.name === create.recurs) ?? held.find((candidate) => candidate.name === create.name);
    if (!match) return null;
    const cameBack = match.sessionId !== sessionId || this.now() - match.lastSeenAt >= SAME_CHAT_BREAK_MS;
    return cameBack || writtenNextSighting(match) ? match : null;
  }

  /** Hold a class of work seen once. A name already held keeps its first sighting and takes the newer wording. */
  hold(candidate: { name: string; description: string; why: string; agentId: string; sessionId: string }): void {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO skill_candidates (name, description, why, agent_id, session_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET description = excluded.description, why = excluded.why, last_seen_at = excluded.last_seen_at,
           sightings = skill_candidates.sightings + 1`,
      )
      .run(candidate.name, candidate.description, candidate.why, candidate.agentId, candidate.sessionId, at, at);
  }

  /** One candidate still held, by name. */
  get(name: string): SkillCandidate | null {
    return this.list().find((candidate) => candidate.name === name) ?? null;
  }

  /** Done with: its skill is being written. */
  take(name: string): void {
    this.db.prepare("DELETE FROM skill_candidates WHERE name = ?").run(name);
  }
}
