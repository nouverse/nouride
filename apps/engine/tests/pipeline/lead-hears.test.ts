/**
 * A delegate at work does not wake its lead (`budget-nudges.ts`).
 *
 * The lead of a helper in the background was woken at every point of the nudge schedule, by the time alone: five
 * minutes, ten, twenty, forty. On a live box, over fourteen days, 21 of 23 such turns ended with nothing said, at 3.3
 * million input tokens; one helper that worked forty-two minutes woke its lead four times, and three of those left a
 * line of steps in the person's chat. A delegate's steps all pass through the daemon, so whether it is at work is
 * read, not guessed. The clock here is the test's.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DelegateSteps, leadHears } from "@/modules/pipeline/budget-nudges.ts";

const FIVE_MIN = 5 * 60_000;

function watched() {
  let now = 1_795_000_000_000;
  const steps = new DelegateSteps(FIVE_MIN, () => now);
  const log: string[] = [];
  let told = 0;
  const nudge = (ms: number) => leadHears(steps, (line) => void log.push(line), ms, () => void (told += 1));
  return { steps, log, told: () => told, nudge, pass: (ms: number) => void (now += ms) };
}

describe("whether a delegate is at work", () => {
  test("a step within the schedule's first wait: at work; the last one longer ago, or none at all: not", () => {
    const d = watched();
    // Nothing is known of one that has made no step: its lead hears, as before.
    expect(d.steps.atWork).toBe(false);
    d.steps.step("tool");
    expect(d.steps.atWork).toBe(true);
    d.pass(FIVE_MIN - 1);
    expect(d.steps.atWork).toBe(true);
    d.pass(1);
    expect(d.steps.atWork).toBe(false);
    // A call that ended is a step too: one long command is at work as it ends, not for the hour it ran.
    d.steps.step("tool_done");
    expect(d.steps.atWork).toBe(true);
  });

  test("only its own work counts: what it thinks or is told is no step", () => {
    const d = watched();
    for (const kind of ["reasoning", "note", "waiting", "thinking"]) d.steps.step(kind);
    expect(d.steps.atWork).toBe(false);
  });
});

describe("a nudge for a delegate in the background", () => {
  test("at work: its log says so, and its lead is not woken", () => {
    const d = watched();
    d.steps.step("tool_done");
    d.pass(60_000);
    d.nudge(FIVE_MIN);
    expect(d.told()).toBe(0);
    expect(d.log).toEqual(["· 5 min in: asked to report if stuck; at work, so its lead is not woken"]);
  });

  test("gone quiet: its lead hears, as before, at the next point of the schedule", () => {
    const d = watched();
    // The helper that worked forty-two minutes: steps all the way, then one command that never came back.
    d.steps.step("tool");
    d.pass(FIVE_MIN - 30_000);
    d.steps.step("tool_done");
    d.pass(30_000);
    d.nudge(FIVE_MIN);
    d.steps.step("tool");
    d.pass(FIVE_MIN);
    d.nudge(2 * FIVE_MIN);
    d.pass(2 * FIVE_MIN);
    d.nudge(4 * FIVE_MIN);
    expect(d.told()).toBe(2);
    expect(d.log).toEqual([
      "· 5 min in: asked to report if stuck; at work, so its lead is not woken",
      "· 10 min in: asked to report if stuck",
      "· 20 min in: asked to report if stuck",
    ]);
  });

  test("one that never made a step is not known to be at work: its lead hears from the first", () => {
    const d = watched();
    d.pass(FIVE_MIN);
    d.nudge(FIVE_MIN);
    expect(d.told()).toBe(1);
    expect(d.log).toEqual(["· 5 min in: asked to report if stuck"]);
  });
});

describe("where it is asked", () => {
  const source = (file: string) => readFileSync(join(import.meta.dir, "../../src/modules/pipeline", file), "utf8");

  test("every delegate that can be in the background: a helper started there, one that moved there, an asked agent", () => {
    for (const file of ["background-helper.ts", "subagent.ts", "peer-turn.ts"]) {
      const text = source(file);
      // Its steps are counted where they pass, and its lead is woken through the one rule.
      expect(text).toMatch(/onActivity: \(kind, text, detail\) => \{\n\s+(steps|made)\.step\(kind\);/);
      expect(text).toContain("leadHears(");
      // Nowhere is the lead woken past it.
      expect(text.match(/ctx\.nudgeLead\?\.\(/g)).toHaveLength(1);
      expect(text.slice(text.indexOf("leadHears("), text.indexOf("leadHears(") + 400)).toContain("ctx.nudgeLead?.(");
    }
  });

  test("the window is the schedule's own first wait, the one the agents' setting names", () => {
    for (const file of ["background-helper.ts", "subagent.ts", "peer-turn.ts"]) {
      expect(source(file)).toMatch(/const baseMs = nudgeBaseMs\(ctx\.deps\.config\.agents\.nudgeAfterMinutes\);\n\s+const (steps|made) = new DelegateSteps\(baseMs\);/);
    }
  });
});
