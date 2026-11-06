/**
 * `contained`: what a timer's callback throws or rejects with is one log line, and goes no further.
 *
 * Further is the daemon's end. An uncaught exception shuts it down, and a test run blames whichever test is running when
 * the timer fires: bun fails the running test on an uncaught exception or an unhandled rejection, which is what makes
 * the interval case below a test of escaping at all.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { contained } from "../src/contained.ts";
import type { LogContext, Logger } from "../src/logger.ts";
import { eventually, sleep } from "./wait.ts";

function recorder(): { log: Logger; errors: { message: string; ctx: LogContext | undefined }[] } {
  const errors: { message: string; ctx: LogContext | undefined }[] = [];
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message, ctx) => void errors.push({ message, ctx }),
    child: () => log,
  };
  return { log, errors };
}


describe("contained", () => {
  test("a listener: the event's arguments are passed through", () => {
    const { log } = recorder();
    const seen: unknown[] = [];
    const emitter = new EventEmitter();
    emitter.on("data", contained(log, "could not take a chunk", (chunk: string, at: number) => void seen.push(chunk, at)));
    emitter.emit("data", "abc", 3);
    expect(seen).toEqual(["abc", 3]);
  });

  test("an abort listener or an emitter's handler that throws is one log line, and the throw goes no further", async () => {
    // Bare, either throw is uncaught — bun fails the running test on one, as the daemon shuts down on one.
    const { log, errors } = recorder();
    const controller = new AbortController();
    controller.signal.addEventListener("abort", contained(log, "could not stop on abort", () => {
      throw new Error("already closed");
    }));
    const emitter = new EventEmitter();
    emitter.on("end", contained(log, "could not settle", () => {
      throw new Error("settled twice");
    }));
    controller.abort();
    emitter.emit("end");
    await sleep(0);
    expect(errors.map((e) => e.message)).toEqual(["could not stop on abort", "could not settle"]);
  });

  test("a throw is logged as what failed, with the error, its stack and the context — and not thrown", () => {
    const { log, errors } = recorder();
    const tick = contained(log, "could not sweep old rows", () => {
      throw new RangeError("database is locked");
    }, { table: "sessions" });

    expect(() => tick()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("could not sweep old rows");
    expect(errors[0]!.ctx).toMatchObject({ table: "sessions", error: "RangeError: database is locked" });
    expect(String(errors[0]!.ctx?.stack)).toContain("contained.test.ts");
  });

  test("a rejection is logged the same way, rather than left for the unhandled-rejection handler", async () => {
    const { log, errors } = recorder();
    contained(log, "the tick failed", async () => {
      throw new Error("closed");
    })();
    await eventually(() => errors.length > 0, 1_000, "the rejection logged");
    expect(errors).toEqual([{ message: "the tick failed", ctx: expect.objectContaining({ error: "Error: closed" }) }]);
  });

  test("a body that works — or a promise that resolves — says nothing", async () => {
    const { log, errors } = recorder();
    let ran = 0;
    contained(log, "x", () => void (ran += 1))();
    contained(log, "y", async () => void (ran += 1))();
    await sleep(0);
    expect(ran).toBe(2);
    expect(errors).toEqual([]);
  });

  test("on an interval, a tick that throws is followed by the next one", async () => {
    const { log, errors } = recorder();
    let ticks = 0;
    const timer = setInterval(contained(log, "the tick failed", () => {
      ticks += 1;
      if (ticks === 1) throw new Error("once");
    }), 5);
    try {
      await eventually(() => ticks >= 3, 2_000, "three ticks");
    } finally {
      clearInterval(timer);
    }
    expect(errors.map((line) => line.message)).toEqual(["the tick failed"]);
  });
});
