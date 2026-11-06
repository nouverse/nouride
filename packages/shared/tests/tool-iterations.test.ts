/**
 * The budget one reply may spend, and the two numbers that decide it.
 *
 * A turn that hits the cap does not fail — the model is asked to summarise and stop — so this is a
 * budget rather than a safety rail. That is exactly why it needs bounds at both ends: too low and
 * the agent reports a half-finished job it was never given room to finish, too high and one mistyped
 * number can outspend a day, because every iteration re-sends the whole conversation.
 */

import { describe, expect, test } from "bun:test";
import {
  TOOL_ITERATIONS_MAX,
  TOOL_ITERATIONS_MIN,
  resolveToolIterations,
  toolIterationsRefusal,
} from "../src/types/config.ts";

describe("what is allowed", () => {
  test("the range that works is accepted", () => {
    for (const value of [TOOL_ITERATIONS_MIN, 25, 100, TOOL_ITERATIONS_MAX]) {
      expect(toolIterationsRefusal(value, "[x] y")).toBeNull();
    }
  });

  test("below the floor is refused, and the refusal says what the floor is for", () => {
    /**
     * `1` used to be legal. It is not a tighter budget — a turn cannot read a file, run a command,
     * read the result and answer in one round trip, so the agent is stopped before it can do the
     * thing it was asked and reports a half-finished job.
     */
    const refusal = toolIterationsRefusal(4, "[llm.limits] max_tool_iterations");
    expect(refusal).toContain("at least 5");
    expect(refusal).toContain("read, run, check, answer");
  });

  test("above the ceiling is refused as a typo, with the range that works", () => {
    const refusal = toolIterationsRefusal(10_000, "[llm.limits] max_tool_iterations");
    expect(refusal).toContain("at most 9999");
    // The hint is the point: a bare bound teaches somebody to set 9999.
    expect(refusal).toContain("50 to 250");
    expect(refusal).toContain("re-sends the whole conversation");
  });

  test("anything that is not a whole number is refused before the bounds are considered", () => {
    for (const junk of [25.5, "25", null, undefined, Number.NaN]) {
      expect(toolIterationsRefusal(junk, "[x] y")).toContain("whole number");
    }
  });

  test("the message names the setting it is about", () => {
    // The same function refuses in three places — the daemon config, an agent's pack, and the
    // dashboard — and each needs to say which one the operator just typed into.
    expect(toolIterationsRefusal(1, "agents/nouva [llm] max_tool_iterations")).toContain(
      "agents/nouva [llm] max_tool_iterations",
    );
  });
});

describe("which number wins", () => {
  test("an agent that names none follows the daemon", () => {
    expect(resolveToolIterations(undefined, 25)).toBe(25);
  });

  test("an agent that names one overrides the daemon, up and down", () => {
    // The whole point of the per-agent field: room for the agent doing long refactors without
    // giving it to the one answering questions in a group chat.
    expect(resolveToolIterations(120, 25)).toBe(120);
    expect(resolveToolIterations(5, 250)).toBe(5);
  });

  test("a value outside the bounds is clamped rather than obeyed", () => {
    /**
     * Config is validated at load, but a pack is a file an agent with write access can edit — and
     * this is the number that decides how much one message may spend. Clamping means the worst a
     * rewritten pack can do is ask for the maximum, not for a million.
     */
    expect(resolveToolIterations(1_000_000, 25)).toBe(TOOL_ITERATIONS_MAX);
    expect(resolveToolIterations(0, 25)).toBe(TOOL_ITERATIONS_MIN);
  });
});
