/**
 * A mission that ended done is handed to skill learning, once (`MissionsDeps.learn`): the work an agent finishes alone
 * is the largest it does, and none of it was looked at for a skill while only a chat's turns were.
 */

import { describe, expect, test } from "bun:test";
import { missionsHarness } from "./harness.ts";

describe("an ended mission and skill learning", () => {
  test("one that ended done is handed to skill learning, once; one that was stopped is not", async () => {
    const h = await missionsHarness({ settings: { maxRunning: 4, perAgent: 4 } });
    const done = await h.start("write the notes", { checks: ["test -s out.md"] });
    h.turn(done, {}, () => h.missions.claim(done.id, { kind: "done", summary: "Notes written.", report: "Wrote them.", files: [] }));
    const stopped = await h.start("another");
    h.missions.stop(stopped.id, "Gading");
    await h.settle();
    expect(h.store.get(done.id)!.status).toBe("done");
    expect(h.store.get(stopped.id)!.status).toBe("stopped");
    expect(h.learned).toEqual([done.id]);
  });
});
