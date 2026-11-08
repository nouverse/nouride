/**
 * The people the agents are told about (`routes/people.ts`): `[[people]]`, and the key that gives someone a memory.
 */

/**
 * One person the agents are told about.
 *
 * `key` is the person — the "Person Key", set once, and the name of their memory file. `ids` are the
 * accounts they send from, all equal, and may be none yet: somebody added by name is attached to their
 * accounts when they pair (Access → Approve as).
 */
export interface PersonRecord {
  key: string;
  name: string;
  ids?: string[];
  notes?: string;
  /** Their morning line's time of day, `07:00` — absent when they have none (0.8.0). */
  morning?: string;
  /** Where it goes: one of their chat accounts — absent, wherever they last wrote from. */
  morningTo?: string;
}

/** Somebody already in `[[people]]` (by key), or somebody new, by name. */
export type PersonTarget = { person: string } | { name: string };
