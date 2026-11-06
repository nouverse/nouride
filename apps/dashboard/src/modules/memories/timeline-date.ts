const DEFAULT_RANGE_DAYS = 7;
export const MAX_RANGE_DAYS = 31;

export function toLocalDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalDate(s: string): Date {
  const [y = 0, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d.getTime());
  copy.setDate(copy.getDate() + n);
  return copy;
}

export function diffInDays(fromStr: string, toStr: string): number {
  const from = parseLocalDate(fromStr);
  const to = parseLocalDate(toStr);
  return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

export function getDefaultRange(today = new Date()): { since: string; until: string } {
  const until = toLocalDateString(today);
  const since = toLocalDateString(addDays(today, -DEFAULT_RANGE_DAYS));
  return { since, until };
}

/** `a` or `b`, whichever is earlier — both `YYYY-MM-DD`, which sort as they read. */
const earlier = (a: string, b: string) => (a < b ? a : b);

/** `since` plus `days`, but never past `today`. */
function aheadOf(since: string, days: number, today: string): string {
  return earlier(toLocalDateString(addDays(parseLocalDate(since), days)), today);
}

/** The latest To the picker offers: 31 days after From, or today, whichever comes first. */
export function latestUntil(since: string | undefined, today: string): string {
  return since ? aheadOf(since, MAX_RANGE_DAYS, today) : today;
}

/** From was picked: it is not after today, and To follows it by a week, not past today. */
export function onSinceChosen(value: string, today: string): { since: string; until: string } {
  const since = earlier(value, today);
  return { since, until: aheadOf(since, DEFAULT_RANGE_DAYS, today) };
}

/** To was picked: not after today, and — with a From — not before it nor more than 31 days after it. */
export function onUntilChosen(value: string, since: string | undefined, today: string): string {
  const until = earlier(value, today);
  if (!since) return until;
  if (until < since) return since;
  return earlier(until, latestUntil(since, today));
}

/** What Apply searches when one end or both were left empty: a week back from To, a week on from From, or the last week. */
export function completeRange(since: string | undefined, until: string | undefined, today: Date): { since: string; until: string } {
  const todayStr = toLocalDateString(today);
  if (!since && !until) return getDefaultRange(today);
  if (!since) return { since: toLocalDateString(addDays(parseLocalDate(until!), -DEFAULT_RANGE_DAYS)), until: until! };
  if (!until) return { since, until: aheadOf(since, DEFAULT_RANGE_DAYS, todayStr) };
  return { since, until };
}
