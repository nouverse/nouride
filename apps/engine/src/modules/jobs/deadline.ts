/**
 * When a background job has run for too long — `[security] job_max_ms` — one timer per job, armed as it starts.
 *
 * Not the watchdog's job. `watchdog.ts` promises it never stops anything, and it should not: it measures silence
 * since the last output, and a healthy build that holds its output until the end is silent the whole way. This
 * measures wall-clock time from the start, the one thing a runaway job and a hung `ssh` have in common, and it is
 * the operator's number, not a guess about the log.
 *
 * Timers rather than a tick, so a limit of a minute means a minute. `unref`'d, so a deadline still pending never
 * holds a daemon that is shutting down. A timer past 2^31 - 1 ms fires at once rather than never, so the config
 * refuses a larger value at load (`config/global/validate.ts`) instead of stopping every job the moment it starts.
 */

import { contained, createLogger } from "@nouride/shared";

const log = createLogger("jobs");

export class JobDeadlines {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * `onExpire` runs once, `ms` from now, unless `clear` comes first. Arming a job again replaces its timer.
   *
   * One that throws — the job's row unreadable at that moment — is logged with the job, and the job is not stopped by
   * this deadline: it is a one-shot, and a person can still `nouride jobs kill` what the line names.
   */
  arm(id: string, ms: number, onExpire: () => void): void {
    this.clear(id);
    const timer = setTimeout(
      contained(log, "a background job's deadline could not stop it", () => {
        this.timers.delete(id);
        onExpire();
      }, { job: id }),
      ms,
    );
    timer.unref?.();
    this.timers.set(id, timer);
  }

  clear(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Deadlines armed and not yet reached — what a test counts to know one was disarmed. */
  pending(): number {
    return this.timers.size;
  }
}
