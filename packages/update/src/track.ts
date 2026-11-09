/**
 * Update tracks (0.8.18): which releases an install is offered.
 *
 * `latest` takes the newest release of all. `lts` stays on a long-term line: 1.0 is the first, not 0.9,
 * and a person on it chooses on the dashboard whether to stay on 1.0 or move to 1.1. It ships before any 1.1 exists
 * because the updater of the version that runs decides what it is offered: a track added in 1.1 would never reach an
 * install on 1.0.
 *
 * Which lines are long-term is a list here, not something read from the channel: the mirror's list carries no such
 * mark, and every further request counts against GitHub's sixty an hour. Core keeps the same list for boxes
 * (`appliances.releases.service.ts`). A line that becomes long-term later is added by the release that makes it so.
 */

import type { Release } from "./release.ts";
import { parseVersion } from "./version.ts";

const UPDATE_TRACKS = ["latest", "lts"] as const;
export type UpdateTrack = (typeof UPDATE_TRACKS)[number];

/** The long-term lines, `major.minor`. */
const LTS_LINES: readonly string[] = ["1.0"];

type Line = readonly [number, number];

function lineOf(version: string): Line | null {
  const parsed = parseVersion(version);
  return parsed ? [parsed.major, parsed.minor] : null;
}

const compareLines = (a: Line, b: Line): number => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);

/**
 * The highest line `lts` moves an install on `current` to: the first long-term line at or above its own, or its own
 * when there is none. 0.8.x goes to 1.0 (staying on 0.8 while no 1.0 is out, since 0.8 is all there is), 1.0.x stays
 * on 1.0 when 1.1 comes, and a line above every long-term one keeps to itself.
 */
export function ltsCeiling(current: string, lines: readonly string[] = LTS_LINES): Line | null {
  const own = lineOf(current);
  if (!own) return null;
  const longTerm = lines
    .map((line) => lineOf(`${line}.0`))
    .filter((line): line is Line => line !== null && compareLines(line, own) >= 0)
    .sort(compareLines);
  return longTerm[0] ?? own;
}

/**
 * The releases a track offers an install on `current`, in the order given.
 *
 * `lts` keeps every line up to its ceiling, not only the ceiling's own: a release on the long-term line may need a
 * newer release of the install's line first (its floor), and that stepping stone is below the ceiling. A tag that is
 * not a version cannot be placed on a line, so `lts` leaves it out; `latest` keeps it, as before.
 */
export function onTrack(releases: Release[], current: string, track: UpdateTrack, lines: readonly string[] = LTS_LINES): Release[] {
  if (track === "latest") return releases;
  const ceiling = ltsCeiling(current, lines);
  if (!ceiling) return releases;
  return releases.filter((release) => {
    const line = lineOf(release.tag);
    return line !== null && compareLines(line, ceiling) <= 0;
  });
}
