/**
 * A box's loops (`boot/appliance.ts`): a step that throws, however it throws, is tried again in five minutes.
 *
 * One that rejected always was. One that threw before it had a promise to reject was called bare inside the timer, so
 * the throw was an uncaught exception — the daemon shuts down on one (`boot/shutdown.ts`) — and the loop never came
 * round again: the box stopped syncing until a restart. Bun fails the running test on an uncaught exception.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { applianceLoop } from "@/boot/appliance.ts";

const warnings: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "appliance" && entry.level !== "info" && entry.level !== "debug" && warnings.push(entry)));

let timers: ReturnType<typeof setInterval>[] = [];
beforeEach(() => {
  warnings.length = 0;
  timers = [];
  jest.useFakeTimers();
});
afterEach(() => {
  for (const timer of timers) clearTimeout(timer);
  jest.useRealTimers();
});

/** The promise chain the timer starts, run out. */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("an appliance loop", () => {
  test("whose step throws before it returns a promise is tried again in five minutes, like one that rejects", async () => {
    let calls = 0;
    const step = () => {
      calls += 1;
      if (calls === 1) throw new Error("the device key could not be read");
      if (calls === 2) return Promise.reject(new Error("the gate answered 503"));
      return Promise.resolve(null);
    };
    applianceLoop("sync", step, 0, timers);

    jest.advanceTimersByTime(0);
    await settle();
    expect(calls).toBe(1);
    jest.advanceTimersByTime(300_000);
    await settle();
    expect(calls).toBe(2);
    jest.advanceTimersByTime(300_000);
    await settle();
    // Answered null: the loop is over.
    expect(calls).toBe(3);
    jest.advanceTimersByTime(3_600_000);
    await settle();
    expect(calls).toBe(3);

    expect(warnings.map((line) => [line.message, line.data?.error])).toEqual([
      ["appliance sync threw", "Error: the device key could not be read"],
      ["appliance sync threw", "Error: the gate answered 503"],
    ]);
  });
});
