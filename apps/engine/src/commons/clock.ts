/**
 * Local calendar time: the day and the hour as the person living them names them, in `[daemon] timezone`.
 *
 * A conversation at 02:00 in Jakarta is on a different UTC date than the one its people would say, so every date
 * the daemon writes or decides by — an episode's id and day, the prompt's "Today", a reminder's time, the hour a
 * rollover or an automatic update happens at — comes from the zone through `Intl`, never from date arithmetic on
 * UTC. One copy, here: it was memory's, and four other places wrote their own, which disagreed about a zone the
 * runtime does not know — some threw, some fell back to UTC. `safeTimeZone` is the one answer: UTC, said by the
 * config's own check, rather than a turn that fails.
 *
 * Pure.
 */

export interface LocalTime {
  /** `2026-09-25` */
  day: string;
  /** `04:59` */
  time: string;
  /** `0459`, for an episode id. */
  slug: string;
  /** `2026-09-25T04:59:44+07:00` — what an episode's `started` and `ended` say. */
  iso: string;
  /** ISO week, `2026-W39`. */
  week: string;
  /** `2026-09` */
  month: string;
}

/** A zone name `Intl` accepts, or UTC — a typo in config must not lose a conversation. */
export function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** ISO 8601 week of a calendar date: weeks start Monday, week 1 holds the year's first Thursday. */
export function isoWeek(day: string): string {
  // The Thursday of this date's week decides the year; week 1 is the one holding January 4th.
  const thursday = new Date(`${day}T00:00:00Z`);
  thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Thursday = new Date(jan4);
  week1Thursday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((thursday.getTime() - week1Thursday.getTime()) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function localTime(at: number, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const offset = get("timeZoneName").replace(/^GMT/, "") || "+00:00";
  const clock = `${get("hour")}:${get("minute")}`;
  return {
    day,
    time: clock,
    slug: `${get("hour")}${get("minute")}`,
    iso: `${day}T${clock}:${get("second")}${offset}`,
    week: isoWeek(day),
    month: day.slice(0, 7),
  };
}

/**
 * The moment the local day holding `at` began — the daily spend cap's day. A zone `Intl` does not know is
 * UTC's day, as everywhere else here: a cap that resets at the wrong hour is a much smaller failure than a
 * turn that fails. Taken at `at`'s own offset, from one reading of the clock.
 */
export function startOfLocalDay(at: number, timeZone: string): number {
  const { day, iso } = localTime(at, safeTimeZone(timeZone));
  // `iso` is `2026-09-25T04:59:44+07:00`: its offset is what follows the seconds.
  return Date.parse(`${day}T00:00:00${iso.slice(19)}`);
}

/**
 * The moment a local day and time name, in `timeZone`. Found by walking offsets from the UTC reading
 * rather than by building a date from parts: offsets are not constant, and reimplementing DST is how a
 * time ends up an hour off twice a year.
 */
export function atLocal(day: string, time: string, timeZone: string): number {
  const guess = Date.parse(`${day}T${time.length === 5 ? `${time}:00` : time}Z`);
  for (let quarter = -56; quarter <= 56; quarter += 1) {
    const at = guess - quarter * 900_000;
    const local = localTime(at, timeZone);
    if (local.day === day && local.time === time.slice(0, 5)) return at;
  }
  return guess;
}
