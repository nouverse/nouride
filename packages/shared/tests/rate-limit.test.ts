/**
 * The brake, and the two ways a brake is worse than none.
 *
 * It exists because the webhook route had nothing: the daemon's only unauthenticated endpoint could
 * start a model turn, and the only guard was `runNow` refusing a concurrent start — which serialises
 * a flood rather than stopping it. A leaked URL was an unbounded bill.
 *
 * The two failure shapes worth testing are not "does it count". They are:
 *
 * 1. **It must not lock out the person it protects.** A login limiter keyed only by account is a way
 *    for anyone to lock a known username out by failing on purpose.
 * 2. **It must not become the outage.** A limiter keyed by something the caller chooses is itself a
 *    memory exhaustion, and one that starts refusing everybody when its own map fills has replaced
 *    the flood with a total failure.
 */

import { describe, expect, test } from "bun:test";
import { parseWindow, rateLimit } from "../src/rate-limit.ts";
import { sleep } from "./wait.ts";


describe("parseWindow", () => {
  test("takes the units a config line would use", () => {
    expect(parseWindow("500ms")).toBe(500);
    expect(parseWindow("30s")).toBe(30_000);
    expect(parseWindow("15m")).toBe(900_000);
    expect(parseWindow("1h")).toBe(3_600_000);
    // A computed value needs no unit.
    expect(parseWindow(1234)).toBe(1234);
  });

  test("refuses what it cannot mean, rather than guessing", () => {
    for (const bad of ["", "m", "15", "15 m", "-1s", "0s", "1d", "1.5m"]) {
      expect(() => parseWindow(bad)).toThrow();
    }
    expect(() => parseWindow(0)).toThrow();
    expect(() => parseWindow(-1)).toThrow();
  });
});

describe("the limit itself", () => {
  test("allows the burst, then refuses, and says how long to wait", () => {
    const limiter = rateLimit({ name: "webhook", by: "token", limit: 3, window: "1m" });

    expect(limiter.check("tok").ok).toBe(true);
    expect(limiter.check("tok").ok).toBe(true);
    const last = limiter.check("tok");
    expect(last.ok).toBe(true);
    expect(last.ok && last.remaining).toBe(0);

    const refused = limiter.check("tok");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    // 3 per minute is one per 20s, and the bucket is empty.
    expect(refused.retryAfterMs).toBeGreaterThan(19_000);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(20_000);
    // Named, so a 429 can say which rule and a log line can say what was counted.
    expect(refused.rule).toBe("webhook");
    expect(refused.by).toBe("token");
  });

  test("keys do not share a bucket", () => {
    const limiter = rateLimit({ name: "webhook", by: "token", limit: 1, window: "1m" });
    expect(limiter.check("a").ok).toBe(true);
    expect(limiter.check("a").ok).toBe(false);
    // The whole reason a webhook counts by token and not by address: one caller must not spend
    // another's allowance.
    expect(limiter.check("b").ok).toBe(true);
  });

  test("refills continuously, so a retry loop can eventually get in", async () => {
    const limiter = rateLimit({ name: "fast", by: "ip", limit: 2, window: "100ms" });
    expect(limiter.check("k").ok).toBe(true);
    expect(limiter.check("k").ok).toBe(true);
    expect(limiter.check("k").ok).toBe(false);

    // Hammering while refused must not push recovery further out — the refused branch deliberately
    // does not spend. Without that, a client retrying in a loop never gets back in.
    for (let i = 0; i < 20; i += 1) limiter.check("k");

    await sleep(70);
    expect(limiter.check("k").ok).toBe(true);
  });

  test("a rule that cannot mean anything is refused at construction", () => {
    expect(() => rateLimit({ name: "x", by: "ip", limit: 0, window: "1m" })).toThrow();
    expect(() => rateLimit({ name: "x", by: "ip", limit: 1.5, window: "1m" })).toThrow();
  });
});

describe("the login shape", () => {
  test("a refund keeps a successful sign-in from counting", () => {
    // The route checks before it knows whether the password was right. A person with the correct
    // password must not spend their own allowance, or a busy admin locks themselves out.
    const limiter = rateLimit({ name: "login", by: "account", limit: 2, window: "15m" });

    expect(limiter.check("gading").ok).toBe(true);
    limiter.refund("gading");
    expect(limiter.check("gading").ok).toBe(true);
    expect(limiter.check("gading").ok).toBe(true);
    expect(limiter.check("gading").ok).toBe(false);
  });

  test("a reset clears the failures behind a person who got in", () => {
    const limiter = rateLimit({ name: "login", by: "account", limit: 2, window: "15m" });
    limiter.check("gading");
    limiter.check("gading");
    expect(limiter.check("gading").ok).toBe(false);

    limiter.reset("gading");
    expect(limiter.check("gading").ok).toBe(true);
  });

  test("a refund on a key that was never seen does nothing", () => {
    const limiter = rateLimit({ name: "login", by: "account", limit: 1, window: "15m" });
    limiter.refund("nobody");
    expect(limiter.size()).toBe(0);
    expect(limiter.check("nobody").ok).toBe(true);
  });
});

describe("the map cannot be the attack", () => {
  test("idle keys are swept rather than accumulating", async () => {
    const limiter = rateLimit({ name: "small", by: "ip", limit: 1, window: "50ms", maxKeys: 4 });

    for (const key of ["a", "b", "c", "d"]) limiter.check(key);
    expect(limiter.size()).toBe(4);

    // Every bucket has refilled, so every one carries no information and is free to forget.
    await sleep(80);
    limiter.check("e");
    expect(limiter.size()).toBe(1);
  });

  test("a full map of live keys allows rather than refusing everybody", () => {
    // The failure this avoids: an attacker with a thousand addresses fills the map, and the limiter
    // starts refusing the one real customer. Allowed-and-untracked degrades; refusing does not.
    const limiter = rateLimit({ name: "small", by: "ip", limit: 5, window: "1h", maxKeys: 2 });

    limiter.check("a");
    limiter.check("b");
    expect(limiter.size()).toBe(2);

    const overflow = limiter.check("c");
    expect(overflow.ok).toBe(true);
    expect(limiter.size()).toBe(2);
    // And the keys it is already tracking keep their real counts.
    for (let i = 0; i < 4; i += 1) limiter.check("a");
    expect(limiter.check("a").ok).toBe(false);
  });
});
