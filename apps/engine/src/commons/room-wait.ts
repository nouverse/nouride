/**
 * One piece of background work's wait for room on the box (0.8.0): while the machine is busy (`box-load.ts`) it does not
 * start, and when it is not, it goes on.
 *
 * Bounded twice. Each look is cheap — a few small files — and a wait sleeps `everyMs` between looks, on one timer. And
 * the time it waits **in all**, however many times it is asked, has a ceiling: past it the work goes on, busy or not,
 * because a box busy for that long is busy as a rule, and work that never runs is a failure nobody sees. The journal
 * says once that it waits, and why, and once that it goes on, per stretch of waiting.
 */

import { contained, createLogger } from "@nouride/shared";
import type { BoxBusy } from "./box-load.ts";

const log = createLogger("box-load");

/**
 * How often a wait looks again — a design constant. The CPU and memory signals are averages over a minute, so a look
 * more often than every half minute mostly reads the same answer; the work goes on within half a minute of the box
 * having room, at two looks a minute.
 */
const EVERY_MS = 30_000;

export interface RoomWaitOptions {
  /** What waits, as the journal names it: "the nightly memory pass", "background helper job_…". */
  what: string;
  /** The most it waits in all. */
  ceilingMs: number;
  /** How often a wait looks again — lowered in tests. */
  everyMs?: number;
  /** Each line also said in the work's own log — a helper's job log — beside the journal. */
  tell?: (line: string) => void;
  now?: () => number;
}

export class RoomWait {
  /** When the stretch of waiting going on now began. */
  private since: number | null = null;
  /** What the stretches before it took. */
  private waited = 0;
  /** The ceiling was reached: it goes on from now on, and asks no more. */
  private spent = false;

  constructor(
    private readonly load: BoxBusy,
    private readonly options: RoomWaitOptions,
  ) {}

  /** Whether the work may go now — one look, no waiting: for work on a clock of its own, which looks again itself. */
  ready(): boolean {
    if (this.spent) return true;
    const now = (this.options.now ?? Date.now)();
    const reason = this.busy();
    const { what, ceilingMs } = this.options;
    if (reason === null) {
      if (this.since !== null) {
        this.waited += now - this.since;
        this.since = null;
        this.say("info", `${what} goes on: the box has room again`, { waited_ms: this.waited });
      }
      return true;
    }
    if (this.since === null) {
      this.since = now;
      this.say("info", `${what} waits while the box is busy: ${reason}`, { at_most_ms: ceilingMs - this.waited });
      return false;
    }
    if (this.waited + (now - this.since) < ceilingMs) return false;
    this.waited += now - this.since;
    this.since = null;
    this.spent = true;
    this.say("warn", `${what} goes on with the box still busy (${reason}): it has waited the most it waits`, { waited_ms: this.waited });
    return true;
  }

  /** Waits until `ready`, looking again every `everyMs`. True to go on; false when `signal` stopped it first. */
  async wait(signal?: AbortSignal): Promise<boolean> {
    while (!this.ready()) {
      if (signal?.aborted) return false;
      await pause(this.options.everyMs ?? EVERY_MS, signal);
      if (signal?.aborted) return false;
    }
    return true;
  }

  /** The load's answer — and, when asking it throws, room: a wait that cannot tell does not hold the work. */
  private busy(): string | null {
    try {
      return this.load.busy();
    } catch (err) {
      log.debug("could not tell whether the box is busy", { what: this.options.what, error: String(err) });
      return null;
    }
  }

  private say(level: "info" | "warn", line: string, data: Record<string, unknown>): void {
    log[level](line, { what: this.options.what, ...data });
    this.options.tell?.(line);
  }
}

/** `ms`, or less when `signal` aborts — the one timer a wait holds. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    // The timer and the abort listener are one contained function, so the listener taken off is the one put on.
    const finish = contained(log, "a wait for room on the box could not end", done);
    const timer = setTimeout(finish, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}
