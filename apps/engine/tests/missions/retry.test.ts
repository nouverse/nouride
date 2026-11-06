/**
 * A mission whose model could not answer — a plan's usage limit, a rate limit, a provider down — pauses and tries again
 * by itself, further apart each time, for about a day (0.8.7, `RETRY_AFTER_MS`). It went straight on twice and then
 * waited for a person: a limit that resets in hours left it stuck, and continued, it failed again at once. Nothing here
 * reads an error's words: any failed turn is the model not answering, whoever's it is.
 */

import { describe, expect, test } from "bun:test";
import { buttonsFor } from "@/modules/missions/actions.ts";
import { retryAfter } from "@/modules/missions/decide.ts";
import { RETRY_AFTER_MS, RETRY_ATTEMPTS } from "@/modules/missions/limits.ts";
import type { Mission } from "@/modules/missions/types.ts";
import { missionsHarness } from "./harness.ts";

type Harness = Awaited<ReturnType<typeof missionsHarness>>;

const MINUTE = 60_000;
const LIMIT = "Claude AI usage limit reached";

/** A turn that failed: its model could not answer. */
const fail = (h: Harness, mission: Mission, error = LIMIT) => h.turn(mission, { failed: true, worked: 0, toolCalls: 0, error });

/** The minute's check, `ms` on. */
function after(h: Harness, ms: number): void {
  h.tick(ms);
  h.missions.tick();
}

const state = (h: Harness, mission: Mission) => {
  const now = h.store.get(mission.id)!;
  return { status: now.status, waitKind: now.waitKind };
};

describe("a turn its model could not answer", () => {
  test("pauses the mission — no turn at once — and says so once, with Retry now and Stop", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    const queued = h.queued.length;
    fail(h, mission);
    expect(state(h, mission)).toEqual({ status: "waiting", waitKind: "retry" });
    expect(h.store.get(mission.id)!.reason).toBe(LIMIT);
    expect(h.queued.length).toBe(queued);
    const notice = h.told.at(-1)!;
    expect(notice.text).toContain(`paused because its model could not answer: ${LIMIT}`);
    expect(notice.text).toContain("tries again by itself");
    expect(notice.buttons?.map((button) => button.label)).toEqual(["Retry now", "Stop"]);
  });

  test("tries again when its time comes, not before", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    fail(h, mission);
    const queued = h.queued.length;
    after(h, RETRY_AFTER_MS[0] - MINUTE);
    expect(state(h, mission)).toEqual({ status: "waiting", waitKind: "retry" });
    expect(h.queued.length).toBe(queued);
    after(h, MINUTE);
    expect(state(h, mission)).toEqual({ status: "running", waitKind: null });
    expect(h.queued.length).toBe(queued + 1);
    expect(h.queued.at(-1)!.text).toContain(`its model could not answer at the last try (${LIMIT}). Trying again`);
  });

  test("further apart each time — and quiet after the first, nobody asked anything new", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    const waits: number[] = [];
    fail(h, mission);
    const told = h.told.length;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      // Minute by minute until it tries again: how long it waited.
      let waited = 0;
      while (h.store.get(mission.id)!.status === "waiting") {
        after(h, MINUTE);
        waited += MINUTE;
        if (waited > 3 * 60 * MINUTE) throw new Error("it never tried again");
      }
      waits.push(waited);
      fail(h, mission);
    }
    expect(waits).toEqual([2, 10, 30, 60, 60, 60].map((minutes) => minutes * MINUTE));
    expect(h.told.length).toBe(told);
  });

  test("answering again, it goes on — said once — and a later failure starts over from the shortest wait", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    fail(h, mission);
    after(h, RETRY_AFTER_MS[0]);
    fail(h, mission);
    after(h, RETRY_AFTER_MS[1]);
    h.turn(mission, { worked: 1 });
    expect(state(h, mission)).toEqual({ status: "running", waitKind: null });
    expect(h.told.at(-1)!.text).toBe(`▶ Mission ${mission.id.slice(0, 10)} goes on: its model answered again after 2 tries.`);
    const told = h.told.length;
    h.turn(mission, { worked: 1 });
    expect(h.told.length).toBe(told);
    fail(h, mission);
    expect(h.told.at(-1)!.text).toContain("paused because its model could not answer");
    after(h, RETRY_AFTER_MS[0]);
    expect(state(h, mission).status).toBe("running");
  });

  test(`after ${RETRY_ATTEMPTS} tries — about a day — a person decides, with the last error`, async () => {
    const h = await missionsHarness({ settings: { limitHours: 1000, limitTurns: 1000 } });
    const mission = await h.start();
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      fail(h, mission, `limit, try ${attempt}`);
      expect(state(h, mission)).toEqual({ status: "waiting", waitKind: "retry" });
      after(h, retryAfter(attempt));
    }
    fail(h, mission, "limit, the last");
    expect(state(h, mission)).toEqual({ status: "waiting", waitKind: "stuck" });
    expect(h.store.get(mission.id)!.reason).toContain(`could not answer for ${RETRY_ATTEMPTS} tries over about a day (the last: limit, the last`);
    expect(h.told.at(-1)!.buttons?.map((button) => button.label)).toEqual(["Continue", "Accept as it is", "Stop"]);
  });

  test("its time paused is not its time worked: a limit of an hour is not reached by waiting on the model", async () => {
    const h = await missionsHarness({ settings: { limitHours: 1 } });
    const mission = await h.start();
    // Four tries: 2 + 10 + 30 + 60 minutes paused, past the hour on the clock.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      fail(h, mission);
      after(h, retryAfter(attempt));
    }
    fail(h, mission);
    expect(state(h, mission)).toEqual({ status: "waiting", waitKind: "retry" });
  });
});

describe("what a person says to a paused mission", () => {
  test("Retry now: a turn at once; failing again, it waits the shortest time and says so again", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    fail(h, mission);
    after(h, RETRY_AFTER_MS[0]);
    fail(h, mission);
    const queued = h.queued.length;
    h.missions.continueMission(mission.id, "Gading");
    expect(state(h, mission).status).toBe("running");
    expect(h.queued.length).toBe(queued + 1);
    fail(h, mission);
    expect(h.told.at(-1)!.text).toContain("paused because its model could not answer");
    after(h, RETRY_AFTER_MS[0]);
    expect(state(h, mission).status).toBe("running");
  });

  test("Stop: it ends, and its time coming round tries nothing", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    fail(h, mission);
    h.missions.stop(mission.id, "Gading");
    const queued = h.queued.length;
    after(h, RETRY_AFTER_MS[3]);
    expect(state(h, mission).status).toBe("stopped");
    expect(h.queued.length).toBe(queued);
  });

  test("Accept as it is: done, its checks not passed", async () => {
    const h = await missionsHarness();
    const mission = await h.start("ship it", { checks: ["test -s out.md"] });
    fail(h, mission);
    h.missions.accept(mission.id, "Gading");
    await h.settle();
    expect(h.store.get(mission.id)).toMatchObject({ status: "done", reason: "accepted by Gading as it stood, without its checks passing" });
  });

  test("the buttons are its own, and a Stop pressed after it went on does nothing", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    fail(h, mission);
    const buttons = buttonsFor(h.store.get(mission.id)!)!;
    expect(buttons.map((button) => button.data)).toEqual([`mission:do:${mission.id}:continue:retry`, `mission:do:${mission.id}:stop:retry`]);
    after(h, RETRY_AFTER_MS[0]);
    const { ActionPresses } = await import("@/modules/missions/actions.ts");
    const presses = new ActionPresses({ missions: h.missions, isAdmin: () => false });
    const pressed = await presses.press({ gatewayId: "telegram:nova", chatId: "8142", chatType: "dm", messageId: "m1", data: buttons[1]!.data, senderId: "8142", senderName: "Gading" });
    expect(pressed.notice).toContain("has moved on (running)");
    expect(state(h, mission).status).toBe("running");
  });
});

describe("across a restart", () => {
  test("a paused mission is tried again from the shortest wait: what it had counted was in memory", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    fail(h, mission);
    after(h, RETRY_AFTER_MS[0]);
    fail(h, mission);
    // The next try was 10 minutes away; the restart forgot it was the second.
    h.missions.afterRestart();
    after(h, RETRY_AFTER_MS[0]);
    expect(state(h, mission).status).toBe("running");
  });

  test("the box off for hours while it was paused: tried again at once, and nobody told it still waits for them", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    fail(h, mission);
    const told = h.told.length;
    after(h, 5 * 60 * MINUTE);
    expect(state(h, mission).status).toBe("running");
    expect(h.told.slice(told).map((one) => one.text)).toEqual([]);
  });

  test("a turn the person stopped is not a failure: nothing pauses", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.turn(mission, { failed: true, worked: 0, error: "stopped", interrupted: true });
    expect(state(h, mission).status).toBe("running");
  });
});
