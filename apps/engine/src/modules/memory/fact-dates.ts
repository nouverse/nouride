/**
 * Dates a fact carries in its own words.
 *
 * ```markdown
 * - Staying in Bandung for the project (until 2026-12-20). ([[…]]) {sam}
 * - Dentist appointment (on 2026-10-03). ([[…]]) {sam}
 * - Birthday (on --03-12). ([[…]]) {sam}
 * ```
 *
 * In the text rather than in a field of their own, so a fact stays one line a person can read and edit
 * in Obsidian, and every rule that already holds for a fact — who may read it, undo, the changes feed,
 * forget — holds for its date too. `--MM-DD` is ISO 8601's date without a year: once a year.
 *
 * Pure.
 */

const UNTIL = /\(until (\d{4}-\d{2}-\d{2})\)/;
const ON = /\(on (\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})\)/;

/** The section follow-ups are kept under — what someone said would be done later, or asked to be reminded of. */
export const FOLLOW_UPS = "Follow-ups";

/** A fact whose `(until …)` day is before today is over: not shown, not found. */
export function isOver(text: string, today: string): boolean {
  const until = UNTIL.exec(text)?.[1];
  return until !== undefined && until < today;
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The next day a fact's `(on …)` date falls on, from `today`, when that is within `days` — today
 * included. A yearly date past this year's falls next year.
 */
export function comingOn(text: string, today: string, days: number): string | null {
  const on = ON.exec(text)?.[1];
  if (!on) return null;
  const last = addDays(today, days);
  let next = on;
  if (on.startsWith("--")) {
    const year = Number(today.slice(0, 4));
    next = `${year}${on.slice(1)}`;
    if (next < today) next = `${year + 1}${on.slice(1)}`;
  }
  return next >= today && next <= last ? next : null;
}
