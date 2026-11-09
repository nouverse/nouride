/**
 * What a turn's helpers and peers run on — inside the ceiling, and never waiting on it.
 *
 * `delegate` ran up to four helpers and `ask_agent` a peer per call, each a provider stream of its own, and none of
 * them was counted: eight turns each delegating four was forty streams with `max_concurrent_turns` reading eight.
 * Counting them by making each wait for a slot is the obvious fix and the wrong one. The turn that started them holds
 * a slot and waits on them, so at the ceiling every helper waits on a slot held by its own parent, and the daemon
 * stops.
 *
 * So the turn lends them its own slot — it is not calling a provider while it waits on them — and they take more
 * only where the ceiling has room. Where it has none they run one after another on the turn's own: slower, never
 * stuck, and never counted as failed for want of a slot.
 */

export class TurnLanes {
  private ownFree = true;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  /** `borrow` is a free slot from the ceiling, or null — `KeyedQueue.borrow`. */
  constructor(private readonly borrow: () => (() => void) | null) {}

  /**
   * Nothing running and nothing waiting: the turn's slot is its own again. A waiter woken by a lane going back
   * resumes before whoever awaited that work reads this, so it is running by then, never in between.
   */
  get idle(): boolean {
    return this.running === 0 && this.waiting.length === 0;
  }

  async run<R>(work: () => Promise<R>): Promise<R> {
    for (;;) {
      const lane = this.take();
      if (lane) {
        this.running += 1;
        try {
          return await work();
        } finally {
          this.running -= 1;
          lane();
          this.waiting.shift()?.();
        }
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  /** The turn's own lane when free, else one borrowed from the ceiling, else none. Each comes with its way back. */
  private take(): (() => void) | null {
    if (this.ownFree) {
      this.ownFree = false;
      return () => {
        this.ownFree = true;
      };
    }
    return this.borrow();
  }
}
