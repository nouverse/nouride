/**
 * Nudges on a doubling schedule while something runs long — never a kill (0.7.25).
 *
 * The design: a base interval, five minutes by default, and a nudge at the base, then at twice it, four times,
 * eight — 5, 10, 20, 40, 80 minutes. The same rhythm a quiet background job is reported on (`jobs/watchdog.ts`): often
 * enough that nobody is left wondering, rarely enough that a long piece of work is not a stream of interruptions. What
 * a nudge does is the caller's — a note in front of a delegate, a line to the agent that is waiting on it, a note in a
 * chat turn somebody is waiting on. Nothing here stops anything: the turn's own clock does that.
 *
 * One timer at a time, armed for the next nudge due. Its callback is `contained` and every nudge is caught on its own,
 * so a caller's throw is one log line and the schedule carries on (invariant 15). The clock is injectable: `check()` is
 * public, so a test drives the schedule with a `now` of its own instead of waiting minutes.
 */

import { contained, createLogger } from "@nouride/shared";

const log = createLogger("budget-watch");

/** The longest a timer may be armed for: past this, Node fires at once. A longer wait is re-armed when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** One nudge: the first is 1, at the base; the second at twice it; the n-th at base × 2^(n-1). */
export interface Nudge {
  nth: number;
  /** Since the watch started — at least the nudge's own point on the schedule, more when the timer ran late. */
  elapsedMs: number;
  /** The point on the schedule this nudge is for, in milliseconds since the start: 5 min, 10, 20… */
  dueMs: number;
}

export interface BudgetWatchOptions {
  /** The first nudge's wait. Zero or less is off: nothing is ever armed. */
  baseMs: number;
  onNudge: (nudge: Nudge) => void;
  /** When the work began; now when unsaid. */
  startedAt?: number;
  now?: () => number;
  /** What it watches, for the log line a failed nudge leaves. */
  what?: string;
}

export class BudgetWatch {
  private readonly now: () => number;
  private readonly startedAt: number;
  private fired = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly options: BudgetWatchOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
  }

  /** When the n-th nudge is due, in milliseconds since the start. */
  static dueMs(baseMs: number, nth: number): number {
    return baseMs * 2 ** (nth - 1);
  }

  /** Arm the timer for the next nudge. Returns itself, so a watch is started where it is made. */
  start(): this {
    this.arm();
    return this;
  }

  /** No nudge after this one, and no timer left behind. Safe to call twice. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Every nudge due by now, in order — what the timer runs, and what a test calls with its own clock. One that throws
   * is logged and the rest still run: a nudge that failed once must not take the later ones with it.
   */
  check(): number {
    if (this.stopped || this.options.baseMs <= 0) return 0;
    const elapsedMs = this.now() - this.startedAt;
    let count = 0;
    while (!this.stopped && elapsedMs >= BudgetWatch.dueMs(this.options.baseMs, this.fired + 1)) {
      this.fired += 1;
      count += 1;
      const nudge = { nth: this.fired, elapsedMs, dueMs: BudgetWatch.dueMs(this.options.baseMs, this.fired) };
      try {
        this.options.onNudge(nudge);
      } catch (err) {
        log.error("a nudge failed, but the next one is still due", { what: this.options.what ?? "work", nth: nudge.nth, error: String(err) });
      }
    }
    return count;
  }

  private arm(): void {
    if (this.stopped || this.options.baseMs <= 0) return;
    const wait = BudgetWatch.dueMs(this.options.baseMs, this.fired + 1) - (this.now() - this.startedAt);
    this.timer = setTimeout(
      contained(log, "a budget watch could not run its nudge", () => {
        this.timer = undefined;
        this.check();
        this.arm();
      }),
      Math.min(MAX_TIMER_MS, Math.max(0, wait)),
    );
    // A watch never keeps the process alive: the work it watches does that.
    (this.timer as { unref?: () => void }).unref?.();
  }
}
