/**
 * The pacer's arithmetic and its memory — what the 0.7.11 mutation sweep found `outbound-pace.test.ts` not holding:
 * every take there started at time zero with a rate of one, so the refill could be added or divided and still agree;
 * a one-millisecond wait could be skipped; and the table of chats was never full, so forgetting idle ones never ran.
 */

import { describe, expect, test } from "bun:test";
import { Pacer, type Clock } from "../src/commons/pace.ts";

function clockAt(t: number): Clock & { slept: number[]; t: number } {
  const clock = {
    t,
    slept: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.slept.push(ms);
    },
  };
  return clock;
}

const remembered = (pacer: Pacer) => (pacer as unknown as { chats: Map<string, unknown> }).chats.size;

describe("the refill", () => {
  test("refills in proportion to the time since the last send, from when that send was counted", async () => {
    // Two a second, so half a second is one message's worth; the clock starts far from zero.
    const clock = clockAt(50_000);
    const pacer = new Pacer({ perChat: () => ({ count: 2, perMs: 1_000 }) }, clock);
    await pacer.take("a");
    await pacer.take("a");
    clock.t += 500;
    await pacer.take("a");
    expect(clock.slept).toEqual([]);
    // Another 250 ms is half a message: the next waits the other half, measured from the last take, not the first.
    clock.t += 250;
    await pacer.take("a");
    expect(clock.slept).toEqual([250]);
  });

  test("a wait of one millisecond is still waited", async () => {
    const clock = clockAt(1_000);
    const pacer = new Pacer({ perChat: () => ({ count: 1, perMs: 1 }) }, clock);
    await pacer.take("a");
    await pacer.take("a");
    expect(clock.slept).toEqual([1]);
  });
});

describe("the chats it remembers", () => {
  test("up to a thousand, and then the ones whose bucket is full again are forgotten — and only those", async () => {
    const clock = clockAt(0);
    const pacer = new Pacer({ perChat: () => ({ count: 1, perMs: 1_000 }) }, clock);
    for (let n = 0; n < 999; n += 1) await pacer.take(`idle-${n}`);
    clock.t = 1_000;
    await pacer.take("busy");
    // A thousand: nothing needed forgetting yet.
    expect(remembered(pacer)).toBe(1_000);
    await pacer.take("new");
    // The 999 idle ones are full again and go; `busy` sent this instant and stays, with the newcomer.
    expect(remembered(pacer)).toBe(2);
  });
});
