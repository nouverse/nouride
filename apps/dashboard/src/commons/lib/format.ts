/**
 * Sizes and times, written the way a person reads them.
 *
 * One of each. `formatBytes` was written three times (the file picker, the update page, and the
 * approval card's `bytes()`), and `ago` twice with different answers (the box page said "never" and
 * fell back to a full date after a day; the access lists said "3 days ago"). Two places that should
 * agree are where they drift, so they are here, and `tests/format.test.ts` pins them.
 */

/** `1.2 MB`. Bytes are only interesting to a person as a rough magnitude. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A length of time, to the unit that matters: "less than a minute", "5 min", "3 h", "2 days". */
function span(ms: number): string {
  if (ms < MINUTE) return "less than a minute";
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  const days = Math.round(ms / DAY);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** How long ago: "just now" under a minute, then "5 min ago", "3 days ago". */
export const ago = (at: number, now = Date.now()) => (now - at < MINUTE ? "just now" : `${span(now - at)} ago`);

/** How long until: "in 5 min"; a moment already past is "in less than a minute". */
export const inTime = (at: number, now = Date.now()) => `in ${span(Math.max(0, at - now))}`;
