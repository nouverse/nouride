/**
 * How long a mission is kept, and what takes it (0.8.0). An ended one goes with its conversation, on `[retention]
 * session_days`; one still open never does, however old. Deleting its own conversation takes it — stopped first while it
 * runs, or it worked on with its checklist deleted. A person's own chat — reset, deleted, a new one every hour — is not
 * its conversation, and touches none of this.
 */

import { describe, expect, test } from "bun:test";
import { missionsHarness } from "./harness.ts";

const DAY = 86_400_000;

describe("kept as long as its conversation", () => {
  test("ended past session_days, swept; ended since, kept; still open, kept however old; 0 keeps everything", async () => {
    const h = await missionsHarness({ settings: { perAgent: 3, maxRunning: 3 } });
    const open = await h.start("still running after a month");
    const old = await h.start("ended a month ago");
    h.missions.stop(old.id, "Gading");
    h.tick(31 * DAY);
    const recent = await h.start("ended yesterday");
    h.missions.stop(recent.id, "Gading");
    h.tick(DAY);

    expect(h.store.sweep(0, h.now())).toBe(0);
    expect(h.store.sweep(30, h.now())).toBe(1);
    expect(h.store.get(old.id)).toBeNull();
    expect(h.store.get(recent.id)?.status).toBe("stopped");
    expect(h.store.get(open.id)?.status).toBe("running");
  });
});

describe("its own conversation deleted", () => {
  test("a running mission is stopped, its chat told, then its folder and its record go", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.missions.forget(mission.id, "gading");
    expect(h.stopped).toEqual([mission.id]);
    expect(h.told.at(-1)?.text).toContain("stopped by gading");
    expect(h.removed).toEqual([mission.id]);
    expect(h.store.get(mission.id)).toBeNull();
  });

  test("an ended one goes quietly: nothing said again, its folder and record removed", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.missions.stop(mission.id, "Gading");
    const said = h.told.length;
    h.missions.forget(mission.id, "gading");
    expect(h.told).toHaveLength(said);
    expect(h.removed).toEqual([mission.id]);
    expect(h.store.get(mission.id)).toBeNull();
  });
});
