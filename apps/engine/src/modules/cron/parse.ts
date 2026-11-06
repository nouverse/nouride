/**
 * Turning what a person (or a model) writes into a trigger, and back again for display.
 *
 * Shared by the tool, the CLI and the control API on purpose. "in 2 hours" has to mean the same
 * instant whichever of the three said it, and three parsers is three chances for it not to.
 */

import type { JobTrigger } from "@nouride/shared";
import { assertTimezone, nextCronOccurrence, parseCronExpr } from "@/modules/cron/expr.ts";
import { CronValidationError } from "@/modules/cron/validate.ts";

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * `30s`, `15m`, `2h`, `1d`, `1h30m` → milliseconds. `null` when it is not a duration at all.
 *
 * A bare number is refused rather than guessed at. `every: 5` is five of *something* and every
 * choice of unit is wrong for somebody — five seconds would be a schedule nobody meant and the
 * kind of mistake that is only noticed by the bill.
 */
function parseDuration(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return null;

  const matches = [...trimmed.matchAll(/(\d+)\s*([smhdw])/g)];
  if (matches.length === 0) return null;

  // The whole string has to be consumed by unit-suffixed numbers. Without this, `2 hours ago`
  // parses as 2 hours and schedules something in the future for a time in the past.
  const consumed = matches.reduce((sum, m) => sum + m[0].length, 0);
  if (consumed !== trimmed.replace(/\s+/g, "").length) return null;

  return matches.reduce((total, m) => total + Number(m[1]) * (UNITS[m[2] as string] ?? 0), 0);
}

export interface ScheduleInput {
  /** ISO 8601, or a relative duration like `2h`. */
  at?: string;
  /** A duration like `15m`. */
  every?: string;
  /** A 5-field cron expression. */
  cron?: string;
  /** IANA zone for `cron`, and for an `at` with no offset. */
  tz?: string;
}

/**
 * Exactly one of `at`, `every` or `cron`.
 *
 * Refusing two is not pedantry: `at` and `every` together has no defensible meaning, and picking
 * one silently would give the caller a schedule they did not ask for and no way to notice.
 */
export function parseScheduleInput(
  input: ScheduleInput,
  now: number,
  defaultTz: string,
): JobTrigger {
  const given = [input.at, input.every, input.cron].filter(Boolean);
  if (given.length === 0) {
    throw new CronValidationError("give a trigger: `at` for once, `every` for an interval, or `cron`.");
  }
  if (given.length > 1) {
    throw new CronValidationError("give exactly one of `at`, `every` or `cron`.");
  }

  if (input.tz) assertTimezone(input.tz);

  if (input.at !== undefined) {
    return { kind: "at", at: parseInstant(input.at, now, input.tz ?? defaultTz) };
  }

  if (input.every !== undefined) {
    const ms = parseDuration(input.every);
    if (ms === null) {
      throw new CronValidationError(
        `\`${input.every}\` is not an interval. Use a number and a unit: 30s, 15m, 6h, 1d.`,
      );
    }
    return { kind: "every", everyMs: ms };
  }

  const expr = (input.cron as string).trim();
  // Parsed here as well as in the store, so a bad expression is refused by whichever layer the
  // caller reached first and the message names the field either way.
  parseCronExpr(expr);
  return { kind: "cron", expr, ...(input.tz ? { tz: input.tz } : {}) };
}

/**
 * An absolute instant from `2h`, `2026-08-19T09:00:00+07:00`, or `2026-08-19 09:00`.
 *
 * The third form is the one that needs care: a datetime with no offset is what people actually
 * type, and reading it as UTC puts a 09:00 reminder at 16:00 for an operator in Jakarta. It is
 * read in `tz` instead.
 */
function parseInstant(text: string, now: number, tz: string): number {
  const trimmed = text.trim();

  const relative = parseDuration(trimmed);
  if (relative !== null) return now + relative;

  // Offset or `Z` present: the string already says which instant it means.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) throw new CronValidationError(`\`${text}\` is not a timestamp.`);
    return parsed;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) {
    throw new CronValidationError(
      `\`${text}\` is not a time. Use a duration (2h), or a timestamp (2026-08-19 09:00).`,
    );
  }
  assertTimezone(tz);

  const [, y, mo, d, h, mi, sec] = match;
  // The same two-pass wall-clock → instant conversion the cron search ends with, reached through
  // the one implementation of it: a minute-resolution cron expression naming this time and this
  // string must resolve to the same instant.
  const naive = Date.UTC(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? 0),
  );
  const asIfUtcCron = parseCronExpr(`${Number(mi)} ${Number(h)} ${Number(d)} ${Number(mo)} *`);
  try {
    // Search from a minute before the naive reading in the target zone; offsets are within ±14h, so
    // starting a day and a half early covers every zone without scanning a year.
    return nextCronOccurrence(asIfUtcCron, naive - 36 * 3_600_000, tz);
  } catch {
    throw new CronValidationError(`\`${text}\` is not a valid date in ${tz}.`);
  }
}

/** One line an operator can read: what this schedule means. */
export function describeTrigger(trigger: JobTrigger, defaultTz: string): string {
  switch (trigger.kind) {
    case "at":
      return `once, at ${new Date(trigger.at).toISOString()}`;
    case "every":
      return `every ${formatDuration(trigger.everyMs)}`;
    case "cron":
      return `cron \`${trigger.expr}\` (${trigger.tz ?? defaultTz})`;
    case "webhook":
      return "when its webhook is called";
  }
}

function formatDuration(ms: number): string {
  for (const [unit, size] of [["d", UNITS.d], ["h", UNITS.h], ["m", UNITS.m], ["s", UNITS.s]] as const) {
    const value = ms / (size as number);
    if (value >= 1 && Number.isInteger(value)) return `${value}${unit}`;
  }
  return `${Math.round(ms / 1000)}s`;
}
