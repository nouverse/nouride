/**
 * A mission as it ends is handed on, once, with how it ended and who started it: what keeps one another agent started
 * for both agents' own chats (`modules/pipeline/work-done.ts`, wired in `boot/missions.ts`). Before, the agent that
 * ran it had nothing of it in its own chats once it was over.
 */

import { describe, expect, test } from "bun:test";
import { missionDone } from "@/modules/pipeline/work-done.ts";
import { missionsHarness } from "./harness.ts";

describe("a mission as it ends", () => {
  test("is handed on once, as it ended: one another agent started, and one a person did", async () => {
    const h = await missionsHarness({ settings: { perAgent: 2 } });
    const theirs = await h.start("tidy the logs", { byAgent: "nix" });
    const own = await h.start("write the notes");
    expect(h.helped).toEqual([]);

    h.missions.stop(theirs.id, "Gading");
    expect(h.helped).toEqual([`${theirs.id} stopped by nix`]);
    h.missions.stop(own.id, "Gading");
    expect(h.helped).toEqual([`${theirs.id} stopped by nix`, `${own.id} stopped by a person`]);

    // Which of them is kept is the row's to say: another agent's, with how it ended and its id to read the rest from.
    const ended = h.store.get(theirs.id)!;
    expect(missionDone(ended)).toMatchObject({ kind: "mission", helper: ended.agentId, asker: "nix", task: "tidy the logs", ref: theirs.id, outcome: expect.stringContaining("stopped") });
    expect(missionDone(h.store.get(own.id)!)).toBeNull();
  });
});
