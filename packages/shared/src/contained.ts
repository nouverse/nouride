import type { LogContext, Logger } from "./logger.ts";

/**
 * A timer's callback, with whatever goes wrong in it said where it went wrong — and kept there.
 *
 * Nothing is above a `setTimeout` or `setInterval` callback to catch what it throws, so a throw is an uncaught
 * exception, and the daemon shuts down on one (`apps/engine/src/boot/shutdown.ts`): a database busy at the wrong moment
 * in an hourly check would end every conversation to report it. A promise the callback lets go of reaches the
 * `unhandledRejection` handler instead when it rejects, and that handler can say only that a `.catch()` is missing
 * somewhere — not which timer, nor what it was doing.
 *
 * Wrapped, either is one line in the component's own log — `failed`, what was being done, with the error and its stack
 * — and the timer carries on: an interval ticks again, a one-shot is spent. Where failing ought to do something more —
 * settle a waiter, look again later — the body does that itself, and this is what is left over. `lint:timers`
 * (`scripts/check-timers.ts`) refuses a timer callback in daemon code that is neither this nor a form that cannot
 * throw.
 *
 * An event's listener is the same case — an abort listener, a socket's or a child process's handler: whoever emits it
 * is the event loop, so what it throws is uncaught — and takes the event's arguments, which are passed through.
 */
export function contained<A extends unknown[]>(log: Logger, failed: string, body: (...args: A) => unknown, context: LogContext = {}): (...args: A) => void {
  const report = (err: unknown): void => {
    log.error(failed, { ...context, error: String(err), ...(err instanceof Error && err.stack ? { stack: err.stack } : {}) });
  };
  return (...args: A) => {
    try {
      const result = body(...args);
      if (result instanceof Promise) result.catch(report);
    } catch (err) {
      report(err);
    }
  };
}
