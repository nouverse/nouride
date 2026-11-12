/**
 * The install's quiet hours (`[cron] quiet_hours`): a span of the day, written `"22:00-07:00"`, in the daemon's time
 * zone. Inside it what an automation would say to a chat is kept and sent as one message when it ends.
 *
 * Pure: minutes of the day in, yes or no out. The clock and the zone are the caller's.
 */

/** A span of the day, in minutes from midnight. `from` after `to` is a span over midnight. */
export interface QuietHours {
  from: number;
  to: number;
}

const SPAN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** `"22:00-07:00"` as a span, or null for anything else. The two ends the same is no span: it would be all day or none. */
export function parseQuietHours(value: string): QuietHours | null {
  const match = SPAN.exec(value.trim());
  if (!match) return null;
  const from = Number(match[1]) * 60 + Number(match[2]);
  const to = Number(match[3]) * 60 + Number(match[4]);
  return from === to ? null : { from, to };
}

/** A span as it is written: `"22:00-07:00"`. */
export function formatQuietHours(hours: QuietHours): string {
  const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return `${clock(hours.from)}-${clock(hours.to)}`;
}

/** Whether a minute of the day is inside the span: from its start, up to and not at its end. */
export function isQuiet(hours: QuietHours, minuteOfDay: number): boolean {
  return hours.from < hours.to ? minuteOfDay >= hours.from && minuteOfDay < hours.to : minuteOfDay >= hours.from || minuteOfDay < hours.to;
}

/** How many minutes from a minute of the day to the span's end: when what was kept is said. */
export function minutesToQuietEnd(hours: QuietHours, minuteOfDay: number): number {
  return (hours.to - minuteOfDay + 1440) % 1440 || 1440;
}
