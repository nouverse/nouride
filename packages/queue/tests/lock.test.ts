/**
 * The keyed lock.
 *
 * Exists because `write`/`edit` are read-modify-write and G3 gave two agents a shared workspace root,
 * so two turns could read one file, both compute from the pre-edit text, and the second write would
 * silently discard the first. Atomic writes do not help: each is individually atomic and the lost
 * update happens *between* them.
 */

import { describe, expect, test } from "bun:test";
import { createKeyedLock } from "../src/lock.ts";
import { sleep } from "./wait.ts";

const tick = () => sleep(1);

describe("createKeyedLock", () => {
  test("serializes work on the same key", async () => {
    const lock = createKeyedLock();
    const order: string[] = [];

    const slow = lock.run("a", async () => {
      order.push("first:start");
      await tick();
      order.push("first:end");
    });
    const fast = lock.run("a", async () => {
      order.push("second:start");
    });

    await Promise.all([slow, fast]);
    // The interleaving this prevents: second:start between first:start and first:end — two edits that both read
    // the pre-edit text, so the second write silently discards the first.
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("does not serialize across keys", async () => {
    const lock = createKeyedLock();
    let concurrent = 0;
    let peak = 0;

    const work = (key: string) =>
      lock.run(key, async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await tick();
        concurrent -= 1;
      });

    await Promise.all([work("a"), work("b")]);
    expect(peak).toBe(2);
  });

  test("a rejection reaches its own caller", async () => {
    const lock = createKeyedLock();
    await expect(lock.run("a", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  test("a failed holder does not deadlock the key", async () => {
    // The protection is the `.catch()` on the *stored* chain, not the callback shape. Verified by
    // sabotage: removing that catch leaves the chain permanently rejected and every later write to
    // the path is silently dropped — one thrown edit takes the file out of service for the daemon's
    // lifetime.
    const lock = createKeyedLock();
    await lock.run("a", async () => Promise.reject(new Error("boom"))).catch(() => undefined);

    expect(await lock.run("a", async () => "still works")).toBe("still works");
  });

  test("a rejection that nobody awaits still frees the key", async () => {
    // The realistic shape: the tool's caller handles the error elsewhere, so nothing `.catch()`es the
    // returned promise here. If the stored chain were not caught, this would deadlock the path *and*
    // raise an unhandled rejection.
    const lock = createKeyedLock();
    void lock.run("a", async () => Promise.reject(new Error("boom"))).catch(() => undefined);

    expect(await lock.run("a", async () => "recovered")).toBe("recovered");
  });

  test("a failure on one key does not surface on another caller's result", async () => {
    const lock = createKeyedLock();
    const failing = lock.run("a", async () => Promise.reject(new Error("boom")));
    const following = lock.run("a", async () => "ok");

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBe("ok");
  });

  test("keys are released, so the map does not grow forever", async () => {
    // Caught while writing this: the cleanup compared the map against the wrong promise, so the entry
    // was never deleted and the map grew one key per file ever touched.
    const lock = createKeyedLock();
    await lock.run("a", async () => undefined);
    await lock.run("b", async () => undefined);
    expect(lock.activeKeys()).toEqual([]);
  });

  test("a key held by a waiter is still listed", async () => {
    const lock = createKeyedLock();
    const held = lock.run("a", async () => {
      await tick();
    });
    expect(lock.activeKeys()).toEqual(["a"]);
    await held;
  });
});
