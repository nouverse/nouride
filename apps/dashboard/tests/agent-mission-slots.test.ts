import { describe, expect, test } from "bun:test";
import { missionsSaid } from "@/modules/agents/components/AgentMissionSlots";

describe("the missions-at-once card, as it says the number (0.8.11)", () => {
  test("one waits in the queue; more run at once, and two in one repository still take turns", () => {
    expect(missionsSaid(1)).toBe("One at a time: the next waits in the queue and starts by itself.");
    // The dispatcher's own rule (`decide.ts` `blockedBy`): one folder's repository, one mission at a time.
    expect(missionsSaid(3)).toBe("Up to 3 at once, each in a folder of its own. Two in one repository still take turns.");
  });
});
