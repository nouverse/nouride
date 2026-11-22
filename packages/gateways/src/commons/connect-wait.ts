/**
 * What a connection that is not up yet waits on, kept for whoever shows it.
 *
 * A platform's client retries by itself and says nothing. On a live box Telegram's waited thirty minutes, the
 * connection "connecting" throughout, with nothing in the log and nothing on its row: a wait the platform had asked
 * for read exactly as a connection that had hung. So an adapter says what its platform answered (`say`), once in the
 * log for each new reason, and the supervisor says by itself that a connect nothing has answered is still waiting
 * (`begin`). A wait belongs to the connect it was said in: up, failed or stopped, it is over (`end`).
 */

import { contained, type GatewayWaiting, type Logger } from "@nouride/shared";

/**
 * How long a connect may go unanswered before the connection says so. A connect that works answers in a second or
 * two; one that has not after half a minute is waiting on something, and until an adapter says what, that it is
 * waiting at all is the one true thing to say.
 */
export const SLOW_CONNECT_MS = 30_000;

export class ConnectWait {
  private waiting: GatewayWaiting | null = null;
  private slow?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly log: Logger,
    /** Whether the connection is on its way up now: a wait is kept only then. */
    private readonly connecting: () => boolean,
  ) {}

  get now(): GatewayWaiting | null {
    return this.waiting;
  }

  /** The platform's answer makes the connect wait: `untilMs` where it named when to come back. */
  say(reason: string, untilMs?: number): void {
    if (!this.connecting() || this.waiting?.reason === reason) return;
    this.waiting = { reason, since: Date.now(), ...(untilMs !== undefined ? { until: untilMs } : {}) };
    this.log.warn("waiting to connect", { reason, ...(untilMs !== undefined ? { until: new Date(untilMs).toISOString() } : {}) });
  }

  /** A connect begins: nothing is waited on yet, and one nothing has answered after `slowMs` says so itself. */
  begin(slowMs: number, stillAtIt: () => boolean): void {
    this.end();
    this.slow = setTimeout(
      contained(this.log, "could not say a connect is slow", () => {
        if (stillAtIt() && !this.waiting) this.say("It has not answered yet.");
      }),
      slowMs,
    );
    // Nothing waits on it: left referenced it keeps a process alive past everything else.
    this.slow.unref?.();
  }

  /** The connect is over, whichever way. */
  end(): void {
    clearTimeout(this.slow);
    this.waiting = null;
  }
}
