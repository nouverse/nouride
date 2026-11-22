/**
 * An agent's missions that have not ended, wherever each was started: what `/mission` lists in a direct chat.
 */

import { describe, expect, test } from "bun:test";
import type { Mission } from "@/modules/missions/types.ts";
import { missionsHarness } from "./harness.ts";

describe("an agent's open missions", () => {
  test("an agent's missions that have not ended, for `/mission` in a direct chat: its drafts too, never another agent's or one that is over", async () => {
    const h = await missionsHarness({ agents: ["nova", "nox"] });
    const set = (mission: Mission, status: Mission["status"], waitKind: Mission["waitKind"] = null) => h.store.save({ ...h.store.get(mission.id)!, status, waitKind });
    const working = await h.start("one");
    const asks = await h.start("two");
    const over = await h.start("three");
    const failed = await h.start("four");
    const stopped = await h.start("five");
    const draft = await h.start("six");
    await h.start("another agent's", { agentId: "nox" });
    set(working, "running");
    set(asks, "waiting", "input");
    set(over, "done");
    set(failed, "failed");
    set(stopped, "stopped");
    h.store.save({ ...h.store.get(draft.id)!, status: "waiting", waitKind: "accept", startedAt: null });
    expect(h.missions.openFor("nova").map((mission) => mission.id).sort()).toEqual([working.id, asks.id, draft.id].sort());
    expect(h.missions.openFor("nobody")).toEqual([]);
  });
});
