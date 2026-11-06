/**
 * Cron expressions, and the next instant one is due.
 *
 * Written rather than taken from a library for one reason that outweighs the convenience: the
 * whole value of this file is in *when* it says a job fires, and a wrong answer is invisible —
 * the job simply happens at the wrong time, or not at all, and nobody looks at a scheduler that
 * appears to be running. That is worth owning, and it is 200 lines.
 *
 * ## Timezone is the whole difficulty
 *
 * "Every day at 09:00" means 09:00 *where the operator lives*, which is not the daemon's clock
 * and not UTC. So the search runs on **local wall-clock fields** and converts to an instant only
 * once, at the end. The naive alternative — stepping through UTC instants and asking what the
 * local time is at each — is correct but formats a date on every minute of the search, and
 * `0 0 29 2 *` then means four million `Intl` calls before it answers.
 *
 * DST is handled by construction: the wall clock is what the expression talks about, and
 * `epochFromZoned` resolves it against the offset in force on that day. A repeated hour fires
 * twice and a skipped hour does not fire — the same behaviour as the wall clock on the wall.
 *
 * ## Day-of-month and day-of-week are OR, not AND
 *
 * `0 9 15 * 1` is "09:00 on the 15th, **or** any Monday" — not "the 15th if it is a Monday".
 * That is Vixie cron's rule and every implementation follows it, so matching it is right even
 * though it surprises people. It surprises them expensively: the expression above reads like it
 * fires once a month and actually fires five or six times.
 */

import { localTime } from "@/commons/clock.ts";

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Field {
  /** The matching values, as a set. Small enough (≤60) that a set beats interval arithmetic. */
  values: Set<number>;
  /** `*` — kept separately because the day-of-month/day-of-week OR rule turns on it. */
  wildcard: boolean;
}

export interface ParsedCron {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
}

export class CronParseError extends Error {
  constructor(expr: string, detail: string) {
    super(`\`${expr}\` is not a valid cron expression: ${detail}`);
    this.name = "CronParseError";
  }
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names: string[],
  expr: string,
  label: string,
): Field {
  const wildcard = raw === "*";
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    if (!part) throw new CronParseError(expr, `empty entry in the ${label} field`);

    // `*/15` and `10-40/5` share a shape: a range, then a step over it.
    const [rangePart, stepPart] = part.split("/");
    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
      throw new CronParseError(expr, `the step in \`${part}\` (${label}) must be a number`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (step === 0) throw new CronParseError(expr, `a step of 0 in the ${label} field never advances`);

    const resolve = (token: string): number => {
      const named = names.indexOf(token.toLowerCase());
      if (named !== -1) return named + (label === "month" ? 1 : 0);
      if (!/^\d+$/.test(token)) {
        throw new CronParseError(expr, `\`${token}\` is not a ${label} value`);
      }
      return Number(token);
    };

    let from: number;
    let to: number;
    if (rangePart === "*" || rangePart === undefined) {
      from = min;
      to = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      from = resolve(a as string);
      to = resolve(b as string);
    } else {
      from = resolve(rangePart);
      // A bare value with a step means "from here to the end": `5/10` is 5,15,25,…
      to = stepPart === undefined ? from : max;
    }

    if (from < min || to > max || from > to) {
      throw new CronParseError(expr, `${label} must be ${min}-${max}, got \`${part}\``);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }

  if (values.size === 0) throw new CronParseError(expr, `the ${label} field matches nothing`);
  return { values, wildcard };
}

export function parseCronExpr(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      expr,
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string, string, string, string, string,
  ];

  const dow = parseField(dayOfWeek, 0, 7, DAY_NAMES, expr, "day-of-week");
  // 7 and 0 are both Sunday. Normalised here so the matcher never has to know.
  if (dow.values.has(7)) dow.values.add(0);

  return {
    minute: parseField(minute, 0, 59, [], expr, "minute"),
    hour: parseField(hour, 0, 23, [], expr, "hour"),
    dayOfMonth: parseField(dayOfMonth, 1, 31, [], expr, "day-of-month"),
    month: parseField(month, 1, 12, MONTH_NAMES, expr, "month"),
    dayOfWeek: dow,
  };
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * The wall clock in `tz` at a given instant, as fields — read through `commons/clock.ts`, the one reading of
 * a zone. Its `h23` cycle never says 24 for midnight, which `hour12: false` did on some ICU versions and
 * which put a daily job a day late. No UTC fallback here: `assertTimezone` refuses an unknown zone when a
 * job is created, so one never reaches this.
 */
function zonedWall(epochMs: number, tz: string): Wall {
  const { day, time } = localTime(epochMs, tz);
  return {
    year: Number(day.slice(0, 4)),
    month: Number(day.slice(5, 7)),
    day: Number(day.slice(8, 10)),
    hour: Number(time.slice(0, 2)),
    minute: Number(time.slice(3, 5)),
  };
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(epochMs: number, tz: string): number {
  const w = zonedWall(epochMs, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(epochMs / 60_000) * 60_000;
}

/**
 * The instant at which `tz`'s wall clock reads these fields.
 *
 * Two passes, because the offset we need is the one in force *at the answer*, and we only have
 * the question. The first guess is right except within a DST transition, where the second pass
 * corrects it — and inside a skipped hour there is no right answer, so it lands on the instant
 * the clock jumps to.
 */
function epochFromZoned(wall: Wall, tz: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const first = naive - offsetAt(naive, tz);
  return naive - offsetAt(first, tz);
}

/** Calendar arithmetic on wall-clock fields. No timezone involved — this is a date, not an instant. */
function addDays(wall: Wall, days: number): Wall {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  };
}

function weekdayOf(wall: Wall): number {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

function dayMatches(parsed: ParsedCron, wall: Wall): boolean {
  const domMatch = parsed.dayOfMonth.values.has(wall.day);
  const dowMatch = parsed.dayOfWeek.values.has(weekdayOf(wall));

  // Vixie's rule: when both fields are restricted the job fires on *either*. When only one is
  // restricted, the wildcard side must not veto it.
  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true;
  if (parsed.dayOfMonth.wildcard) return dowMatch;
  if (parsed.dayOfWeek.wildcard) return domMatch;
  return domMatch || dowMatch;
}

/**
 * Enough iterations to cross a leap-year-only expression (`0 0 29 2 *` skips up to 8 years, one
 * step per month), and few enough that an expression matching nothing answers in microseconds
 * instead of hanging the tick.
 */
const SEARCH_LIMIT = 5000;

/**
 * The first instant strictly after `after` at which `expr` is due.
 *
 * Throws when the expression can never match — `0 0 30 2 *` parses cleanly and February never
 * has thirty days. Silence there would be a job that sits in the list looking scheduled forever,
 * which is exactly the failure mode a validating parser exists to prevent.
 */
export function nextCronOccurrence(parsed: ParsedCron, after: number, tz: string): number {
  // Start at the next whole minute: cron has minute resolution, and `after` is usually "now".
  let wall = zonedWall(Math.floor(after / 60_000) * 60_000 + 60_000, tz);

  for (let guard = 0; guard < SEARCH_LIMIT; guard++) {
    if (!parsed.month.values.has(wall.month)) {
      // Skip the whole month rather than 30 days one at a time.
      const first: Wall = { year: wall.year, month: wall.month, day: 1, hour: 0, minute: 0 };
      const next = addDays(first, 32);
      wall = { year: next.year, month: next.month, day: 1, hour: 0, minute: 0 };
      continue;
    }
    if (!dayMatches(parsed, wall)) {
      wall = { ...addDays(wall, 1), hour: 0, minute: 0 };
      continue;
    }
    if (!parsed.hour.values.has(wall.hour)) {
      wall = wall.hour === 23
        ? { ...addDays(wall, 1), hour: 0, minute: 0 }
        : { ...wall, hour: wall.hour + 1, minute: 0 };
      continue;
    }
    if (!parsed.minute.values.has(wall.minute)) {
      wall = wall.minute === 59
        ? (wall.hour === 23
            ? { ...addDays(wall, 1), hour: 0, minute: 0 }
            : { ...wall, hour: wall.hour + 1, minute: 0 })
        : { ...wall, minute: wall.minute + 1 };
      continue;
    }

    const epoch = epochFromZoned(wall, tz);
    // A DST spring-forward can map a wall time to an instant at or before where we started.
    // Stepping past it is right: that minute did not exist on that day.
    if (epoch > after) return epoch;
    wall = { ...wall, minute: wall.minute + 1 };
  }

  throw new CronParseError(
    "cron",
    "no occurrence within the next several years: check the day-of-month and month fields",
  );
}

/** Rejects an unknown zone at creation, rather than at 3am on the first run. */
export function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new CronParseError(tz, "not an IANA timezone (try `Asia/Jakarta`)");
  }
}
