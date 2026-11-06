/**
 * A turn's clock: it is stopped after `turnMs` — or, for a coding CLI's mission turn (0.8.7), after `turnMs` without a
 * step. One prompt to a CLI is a whole piece of work it may be on for well over an hour; cut at the hour while it was
 * still running steps, the turn ended as if stuck. Each step it reports starts the clock again (`stillWorking`); a CLI
 * that goes silent is still stopped.
 */

import { contained, createLogger } from "@nouride/shared";

const log = createLogger("pipeline.turn-clock");

export interface TurnClock {
  /** A step reported: for a quiet-only clock, the time starts again. Otherwise nothing. */
  stillWorking(): void;
  stop(): void;
}

/** The timer it runs on — the runtime's, or a test's hand-wound one. */
export interface ClockTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL: ClockTimers = { set: (fn, ms) => setTimeout(contained(log, "a turn's clock could not stop it", fn), ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export function turnClock(turnMs: number, abort: () => void, quietOnly: boolean, timers: ClockTimers = REAL): TurnClock {
  let stopped = false;
  const ring = (): void => {
    stopped = true;
    abort();
  };
  let timer = timers.set(ring, turnMs);
  return {
    stillWorking() {
      if (!quietOnly || stopped) return;
      timers.clear(timer);
      timer = timers.set(ring, turnMs);
    },
    stop() {
      stopped = true;
      timers.clear(timer);
    },
  };
}
