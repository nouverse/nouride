import { describe, expect, test } from "bun:test";
import { createTypingKeepalive } from "../src/commons/typing.ts";

/** Hand-driven clock: the interval fires when the test says so, not when time passes. Every timer armed is kept, so a second one shows. */
function fakeClock() {
  const timers = new Set<{ fn: () => void; unref(): void }>();
  return {
    setInterval: ((callback: () => void) => {
      const timer = { fn: callback, unref() {} };
      timers.add(timer);
      return timer as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearInterval: ((timer: { fn: () => void; unref(): void }) => {
      timers.delete(timer);
    }) as unknown as typeof clearInterval,
    fire: () => {
      for (const timer of timers) timer.fn();
    },
    armed: () => timers.size,
  };
}

/**
 * Drain the microtask queue.
 *
 * `tick` awaits `onTick`, so the `finally` that clears the in-flight flag lands a microtask or two
 * later. A single `await Promise.resolve()` between fires suppresses the next tick — which is the
 * implementation working, not a bug, but it makes the interval test read as an off-by-one.
 */
const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("createTypingKeepalive", () => {

  test("keeps ticking on the interval", async () => {
    const clock = fakeClock();
    let ticks = 0;
    const keepalive = createTypingKeepalive({ intervalMs: 5000, onTick: () => void ticks++, ...clock });

    keepalive.start();
    await flush();
    clock.fire();
    await flush();
    clock.fire();
    await flush();
    expect(ticks).toBe(3);
  });

  test("suppresses overlapping ticks while one is in flight", async () => {
    // A stalled platform API must not accumulate a queue of requests behind it — each one is more
    // load on an API that is already failing.
    const clock = fakeClock();
    let started = 0;
    let release: (() => void) | undefined;
    const keepalive = createTypingKeepalive({
      intervalMs: 5000,
      onTick: () => {
        started++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      ...clock,
    });

    keepalive.start();
    await flush();
    expect(started).toBe(1);

    clock.fire();
    clock.fire();
    clock.fire();
    await flush();
    expect(started).toBe(1);

    release?.();
    await flush();
    clock.fire();
    await flush();
    expect(started).toBe(2);
  });

  test("a failing tick never escapes", async () => {
    // Decoration must not be able to fail a turn.
    const clock = fakeClock();
    const keepalive = createTypingKeepalive({
      intervalMs: 5000,
      onTick: () => Promise.reject(new Error("telegram is down")),
      ...clock,
    });

    keepalive.start();
    await expect(keepalive.tick()).resolves.toBeUndefined();
    expect(keepalive.running).toBe(true);
  });

  test("stop is idempotent and disarms the timer", () => {
    const clock = fakeClock();
    const keepalive = createTypingKeepalive({ intervalMs: 5000, onTick: () => {}, ...clock });

    keepalive.start();
    expect(keepalive.running).toBe(true);
    keepalive.stop();
    keepalive.stop();
    expect(keepalive.running).toBe(false);
    expect(clock.armed()).toBe(0);
  });

  test("start twice does not arm two timers", () => {
    // Two timers would double every tick from then on, and on Telegram that is a rate limit — and `stop` clears only
    // the one it holds, so the other would type into the chat after the turn was over. Counted on the clock: the tick
    // count could not show it, because the second start's immediate tick lands while the first is in flight.
    const clock = fakeClock();
    const keepalive = createTypingKeepalive({ intervalMs: 5000, onTick: () => {}, ...clock });

    keepalive.start();
    keepalive.start();
    expect(clock.armed()).toBe(1);
    keepalive.stop();
    expect(clock.armed()).toBe(0);
  });
});
