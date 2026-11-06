/**
 * `scripts/check-wire.ts` holds the dashboard's hand-kept word lists to the daemon's. A checker that read nothing —
 * every list empty — would say every pair agrees, so this asks that each list it reads has words in it, and that two
 * lists that differ are reported as differing.
 */

import { describe, expect, test } from "bun:test";
import { drift, PAIRS, wordsOf } from "../../../../scripts/check-wire.ts";

describe("the dashboard's copied word lists", () => {
  test("each is read from both sides, with words in it", () => {
    for (const pair of PAIRS) {
      expect({ what: pair.what, dashboard: wordsOf(pair.dashboard).length > 0, daemon: wordsOf(pair.daemon).length > 0 }).toEqual({ what: pair.what, dashboard: true, daemon: true });
    }
  });

  test("match the daemon's today", () => {
    expect(drift()).toEqual([]);
  });

  test("a tagged union is read by its tags — what a job does, on both sides", () => {
    const job = PAIRS.find((pair) => pair.what === "what a job does")!;
    expect(wordsOf(job.dashboard)).toEqual(["systemEvent", "agentTurn", "command", "mission"]);
    expect(wordsOf(job.daemon)).toEqual(["systemEvent", "agentTurn", "command", "mission"]);
  });

  test("and a list that differs is named, with what is missing", () => {
    const turnStatus = PAIRS.find((pair) => pair.what === "a turn's status")!;
    const problems = drift([{ what: "a mismatch made on purpose", dashboard: turnStatus.dashboard, daemon: { file: "packages/shared/src/types/config.ts", type: "SkillLearningMode" } }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('lacks "off"');
    expect(problems[0]).toContain('has "running"');
  });
});
