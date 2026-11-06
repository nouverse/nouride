/**
 * What a mission keeps to that is not a setting (decided 2026-10-25): nobody would tune these, and each would be one more
 * thing a Box owner could set wrong. The five that are settings are `[missions]` (`MissionsSection`). Named as the
 * design names them, so the two can be read side by side.
 */

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

/** A limit reached waits this long for a person's *continue*, then the mission fails with the limit as its reason. */
export const LIMIT_WAIT_MS = 7 * 24 * HOUR;
/** A parked approval stays answerable this long. */
export const APPROVAL_ANSWERABLE_MS = 24 * HOUR;
/** A wait on a person is named again, once, after this long. */
export const FOLLOW_UP_MS = 4 * HOUR;
/** At most one progress line this often — and only when a step finished since the last. */
export const PROGRESS_EVERY_MS = 30 * MINUTE;
/** Running, with no turn, no job and no activity this long: one nudge, then a person is told. */
export const STALL_AFTER_MS = 60 * MINUTE;
/** A final mission's own folder is kept this long, then removed. */
export const KEEP_MS = 7 * 24 * HOUR;
/**
 * …or this long, when the disk is low: its results have gone out by then. On the live box sixteen ended missions'
 * folders held 1.9 GB (worktrees with `node_modules`); a Box on a small eMMC cannot keep a week of that.
 */
export const KEEP_WHEN_DISK_LOW_MS = HOUR;
/** One check command's limit. */
export const CHECK_TIMEOUT_MS = 15 * MINUTE;
/** Missions one agent may start in a day; a person starting one is not counted. */
export const AGENT_MISSIONS_PER_DAY = 20;
/** Restarts that cut one of its turns, with no step finished in between, before the mission fails: one that kills the daemon must not loop. */
export const MAX_RESUMES = 3;
/** Turns in a row that call no tool and change no step, before the mission waits as stuck. */
export const IDLE_TURNS = 3;
/** The same question asked this many times in a row is not sent again. */
export const SAME_QUESTION = 3;
/** The same check failing the same way this many times in a row: the agent cannot pass it alone, and a person decides. */
export const SAME_CHECK = 3;
/** Passes a review that runs out of its clock takes, each going on from the last one's notes, before a person decides. */
export const REVIEW_PASSES = 3;
/**
 * The reviewer's fails in a row, whatever each says, before a person decides: a loop is the cycle — done, rejected, done —
 * and a reviewer finding something new each time never fails "the same way" (`SAME_CHECK`).
 */
export const REVIEW_REJECTIONS = 3;
/**
 * A turn that failed — its model or coding CLI could not answer: a usage limit, a rate limit, a provider down — pauses the
 * mission, which tries again by itself after each of these, then hourly (0.8.7). It went straight on twice and then
 * waited for a person: a plan's limit that resets in hours left it stuck, and continued, it failed again at once.
 * Starting values, chosen to span a five-hour limit within the first few tries; measured use moves them.
 */
export const RETRY_AFTER_MS = [2 * MINUTE, 10 * MINUTE, 30 * MINUTE, HOUR] as const;
/** Tries before a person decides: about a day, at an hour each past the first few — a starting value. */
export const RETRY_ATTEMPTS = 24;
/** A failed check's output on the next page. */
export const CHECK_OUTPUT_CHARS = 4096;
/** Questions and answers kept on the page. */
export const ANSWERS_KEPT = 10;
/** What a person told a mission while it worked, kept on its record; its page shows the last few (`tell.ts`). */
export const TOLD_KEPT = 50;
/** One `tell`, at most: a page is read every turn, and a longer brief belongs in a file it is told about. */
export const TELL_MAX = 4000;
/** At this share of any limit the chat is told, once. */
export const WARN_AT = 0.8;
/** What a mission is asked for with, at most — by a person, an agent, or a scheduled job (`cron/validate.ts`). */
export const GOAL_MAX = 2000;
export const CHECKS_MAX = 10;
export const CHECK_MAX = 500;
export const REVIEW_MAX = 1000;
