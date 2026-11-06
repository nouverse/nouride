/**
 * Time zones, as this machine and `Intl` see them.
 *
 * `Intl`'s own answer is not the host's under a POSIX `TZ`: with `:/etc/localtime`, `UTC0` or `CET-1CEST` set, Bun
 * reports UTC, or a zone that is not the one set, and refuses every one of them as a `timeZone`. So the host's zone is
 * read where the machine keeps it, and every name the daemon is handed is checked against what `Intl` will accept —
 * a zone it refuses makes every `localTime` throw, and the memory pass took the daemon down with it.
 */

import { readFileSync, realpathSync } from "node:fs";

/** Whether `Intl` takes `name` as a zone — what every date the daemon formats goes through. */
export function isTimeZone(name: string): boolean {
  if (!name) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The zone a zoneinfo file is, by where it sits: `/usr/share/zoneinfo/Asia/Jakarta` is `Asia/Jakarta`. */
export function zoneOfFile(path: string): string | null {
  let target: string;
  try {
    target = realpathSync(path);
  } catch {
    return null;
  }
  const at = target.lastIndexOf("/zoneinfo/");
  const name = at >= 0 ? target.slice(at + "/zoneinfo/".length) : "";
  return isTimeZone(name) ? name : null;
}

/**
 * The zone this machine keeps its clock in, as an IANA name: where `/etc/localtime` points, then `/etc/timezone`, then
 * `Intl` with no `TZ` to mislead it, then UTC. What a daemon with no zone of its own runs on — and what its operator,
 * reading the time on the same machine, expects "01:00" to mean.
 */
export function hostTimeZone(): string {
  const local = zoneOfFile("/etc/localtime");
  if (local) return local;
  try {
    const named = readFileSync("/etc/timezone", "utf8").trim();
    if (isTimeZone(named)) return named;
  } catch {
    // Not every system has one.
  }
  const intl = process.env.TZ ? "" : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isTimeZone(intl) ? intl : "UTC";
}
