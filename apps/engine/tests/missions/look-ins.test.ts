/**
 * A mission whose own work is under way (a job, a helper) and the turns the daemon gives it meanwhile: a look-in on a
 * job that still runs is not one of the three idle turns that make a mission stuck.
 */

import { expect, test } from "bun:test";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { missionsHarness } from "./harness.ts";

test("a look-in on a job that still runs is no idle turn: with its helpers at work it is never stuck, and their end wakes it", async () => {
  // msn_17aff8 on the live box: four helpers started, one failed, and five minutes on the three still at work each
  // got the daemon's look-in, back to back. Each turn said nothing and called nothing; the third made the mission
  // "stuck", and the helpers' results, minutes later, found it waiting and started no turn.
  const h = await missionsHarness();
  const mission = await h.start();
  h.turn(mission);
  const helpers = ["job_a", "job_b", "job_c"].map((id) => ({ id, gatewayId: MISSION_GATEWAY_ID, chatId: mission.id }));
  h.jobs.set("nova", helpers);
  for (let i = 0; i < 5; i += 1) h.turn(mission, { worked: 0, toolCalls: 0 });
  expect(h.store.get(mission.id)).toMatchObject({ status: "running", waitKind: null });
  expect(h.told.some((one) => one.text.includes("is stuck"))).toBe(false);
  // Its helpers done, a turn that does something goes on as any does.
  h.jobs.set("nova", []);
  const queued = h.queued.length;
  h.turn(mission, { worked: 2 });
  expect(h.queued.length).toBe(queued + 1);
  // And with nothing of its own under way, three turns that do nothing are still three: the look-ins were not
  // counted towards them, and are not held against it after.
  for (let i = 0; i < 2; i += 1) h.turn(mission, { worked: 0 });
  expect(h.store.get(mission.id)!.status).toBe("running");
  h.turn(mission, { worked: 0 });
  expect(h.store.get(mission.id)).toMatchObject({ status: "waiting", waitKind: "stuck" });
});
