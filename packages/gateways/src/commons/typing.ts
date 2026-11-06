/**
 * Typing-indicator keepalive.
 *
 * Every chat platform expires its typing affordance after a few seconds, so showing it once at the
 * start of a turn means the chat goes quiet while the agent is still working. A turn here can run
 * for minutes — several provider round-trips, a tool that shells out, a human being asked to
 * approve something — and silence in a chat reads as "broken", not "busy".
 *
 * Two things this gets right that a bare `setInterval(() => setTyping())` does not:
 *
 * - **In-flight suppression.** If the platform API stalls past the interval, ticks pile up behind
 *   it and each one is another request to an API that is already struggling. Openclaw hit this and
 *   guards it the same way.
 * - **Failure is never fatal.** A typing indicator is decoration. `onTick` rejecting must not
 *   surface anywhere near the turn, or a cosmetic API blip fails real work.
 */

import { contained, createLogger } from "@nouride/shared";

const log = createLogger("gateway.typing");

export interface TypingKeepalive {
  start(): void;
  stop(): void;
  readonly running: boolean;
  /** Fire one tick now, for tests and for the immediate tick at start. */
  tick(): Promise<void>;
}

export interface TypingKeepaliveOptions {
  /** Comfortably under the platform expiry. 5s suits Telegram and Discord. */
  intervalMs: number;
  onTick: () => Promise<void> | void;
  /** Injectable so tests do not wait in real time. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export function createTypingKeepalive(options: TypingKeepaliveOptions): TypingKeepalive {
  const start_ = options.setInterval ?? setInterval;
  const clear_ = options.clearInterval ?? clearInterval;

  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await options.onTick();
    } catch {
      // Decoration. Swallowed on purpose — see the header.
    } finally {
      inFlight = false;
    }
  };

  return {
    get running() {
      return timer !== undefined;
    },
    tick,
    start() {
      if (timer) return;
      // Immediately, then on the interval: the whole point is that the indicator appears at the
      // start of the turn, not `intervalMs` into it.
      void tick();
      // `tick` swallows what `onTick` does; contained as every timer is, so nothing a later change lets through can
      // leave the timer — where a throw is an uncaught exception, and the daemon shuts down on one.
      timer = start_(contained(log, "a typing indicator tick failed", tick), options.intervalMs);
      // Never hold the process open. A keepalive that keeps a daemon from exiting during shutdown
      // would turn a graceful stop into a hang.
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (!timer) return;
      clear_(timer);
      timer = undefined;
    },
  };
}
