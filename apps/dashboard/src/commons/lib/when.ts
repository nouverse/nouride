/**
 * When something happened, as a list's row says it: the clock for today, "Yesterday", the weekday within the week, the
 * day and month after that, and the year once it is not this one. Calendar days, not hours: 23:00 last night is
 * yesterday at 08:00 this morning.
 */

const DAY = 86_400_000;

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Whole calendar days between `at` and `now`: 0 today, 1 yesterday. */
export function daysAgo(at: number, now: number = Date.now()): number {
  return Math.round((startOfDay(now) - startOfDay(at)) / DAY);
}

export function shortWhen(at: number, now: number = Date.now()): string {
  const when = new Date(at);
  const days = daysAgo(at, now);
  if (days <= 0) return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return when.toLocaleDateString([], { weekday: "short" });
  return when.getFullYear() === new Date(now).getFullYear()
    ? when.toLocaleDateString([], { day: "numeric", month: "short" })
    : when.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}
