import { contained, type Logger } from "@nouride/shared";

/**
 * A buffer's flush, armed by its first entry — never a clock ticking over an empty one.
 *
 * The audit log and the log table each flushed on a two-second interval, so an idle daemon woke sixty times a minute
 * to find two empty buffers. One timer armed when a buffer goes from empty to holding something, fired once, keeps
 * the batching — a line costs an array push, not an insert on the latency path — and an idle daemon wakes for neither.
 */
export class FlushTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    private readonly flush: () => void,
    private readonly delayMs: number,
    /** The buffer's owner's: a flush that throws is said there, and the next entry arms another. */
    private readonly log: Logger,
  ) {}

  /** From now on an entry arms a flush. Before it — a store nobody started — entries wait for an explicit flush. */
  start(): void {
    this.running = true;
  }

  /** An entry went into the buffer: arm a flush unless one is already waiting. */
  arm(): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(
      contained(this.log, "a buffered flush failed", () => {
        this.timer = undefined;
        this.flush();
      }),
      this.delayMs,
    );
    // Housekeeping must never be the reason the process stays alive — the rule every timer in `maintenance.ts` follows.
    this.timer.unref?.();
  }

  /** The buffer was emptied another way: nothing left to wait for. */
  disarm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  stop(): void {
    this.running = false;
    this.disarm();
  }
}
