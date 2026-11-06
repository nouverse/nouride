/**
 * The wall clock's bounds, and what "follow the daemon" resolves to.
 *
 * The clock was configurable before this — `[llm.limits] max_turn_duration_ms` — but only globally,
 * validated by `positiveInt`, which accepted one millisecond and a year alike. Its twin, the tool
 * budget, had already been given bounds, a per-agent override and a form; the clock had none of
 * that, so "configurable" meant one number in a file nobody had a reason to open.
 */

import { describe, expect, test } from "bun:test";
import {
  TURN_SECONDS_MAX,
  TURN_SECONDS_MIN,
  resolveTurnDurationMs,
  turnSecondsRefusal,
} from "../src/types/config.ts";

describe("turnSecondsRefusal", () => {
  test("accepts the band and refuses either side of it", () => {
    expect(turnSecondsRefusal(300, "x")).toBeNull();
    expect(turnSecondsRefusal(TURN_SECONDS_MIN, "x")).toBeNull();
    expect(turnSecondsRefusal(TURN_SECONDS_MAX, "x")).toBeNull();
    expect(turnSecondsRefusal(TURN_SECONDS_MIN - 1, "x")).toContain("at least");
    expect(turnSecondsRefusal(TURN_SECONDS_MAX + 1, "x")).toContain("at most");
  });

  test("says why, not just no", () => {
    // A refusal that only states the bound sends somebody to read the source to find out whether
    // the bound is the real constraint or an arbitrary one.
    expect(turnSecondsRefusal(5, "x")).toContain("reaching the model");
    expect(turnSecondsRefusal(9999, "x")).toContain("queue is per chat");
  });

  test("refuses what is not a whole number of seconds", () => {
    // Milliseconds pasted into a seconds field is the obvious mistake, and 300000 is caught by the
    // ceiling. A fraction is caught here.
    expect(turnSecondsRefusal(30.5, "x")).toContain("whole number");
    expect(turnSecondsRefusal("300", "x")).toContain("whole number");
    expect(turnSecondsRefusal(null, "x")).toContain("whole number");
  });

  test("names the field it was given, so one function can serve three callers", () => {
    expect(turnSecondsRefusal(1, "[llm.limits] max_turn_duration_ms")).toContain(
      "[llm.limits] max_turn_duration_ms",
    );
    expect(turnSecondsRefusal(1, "max_turn_seconds")).toContain("max_turn_seconds");
  });
});

describe("resolveTurnDurationMs", () => {
  test("an agent with none follows the daemon", () => {
    expect(resolveTurnDurationMs(undefined, 300_000)).toBe(300_000);
  });

  test("an agent with its own overrides, in either direction", () => {
    expect(resolveTurnDurationMs(600_000, 300_000)).toBe(600_000);
    expect(resolveTurnDurationMs(60_000, 300_000)).toBe(60_000);
  });

  test("clamps rather than trusts, because a pack is a file an agent can write", () => {
    // Config is validated at load, but `agent_configure`-style edits and hand-editing both reach
    // this number, and it decides what one message may spend.
    expect(resolveTurnDurationMs(1, 300_000)).toBe(TURN_SECONDS_MIN * 1000);
    expect(resolveTurnDurationMs(99_999_999, 300_000)).toBe(TURN_SECONDS_MAX * 1000);
    // The daemon's own value is clamped too: it is the fallback, not a trusted one.
    expect(resolveTurnDurationMs(undefined, 1)).toBe(TURN_SECONDS_MIN * 1000);
  });
});
