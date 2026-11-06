/**
 * The clock a coding CLI's turn is given in these tests (0.8.10): its first prompt carries the time in the household's
 * zone among its notes, as a model's message does — fixed here, so a test reads the prompt the CLI was sent word for word.
 */

import { clockNote } from "@/modules/llm/executor/reminders.ts";

const AT = new Date("2026-10-31T07:05:00Z");
const ZONE = "Asia/Jakarta";

/** What the turn's deps carry: the zone, and a clock that does not move. */
export const clockDeps = { timezone: ZONE, now: () => AT };

/** The note a turn's first prompt ends with, after a blank line, before its other notes. */
export const CLOCK = clockNote(AT, ZONE);
