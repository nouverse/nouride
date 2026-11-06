/**
 * The Agents pages show what an agent is doing (0.7.18), from `/status`'s `activity`; a daemon before that sends
 * only the pack's state, shown as it was.
 */

import { describe, expect, test } from "bun:test";
import { statusBadge } from "@/commons/components/agent-status-badge";

const activity = (over: Partial<NonNullable<Parameters<typeof statusBadge>[0]["activity"]>>) => ({
  activity: "idle" as const,
  working: [],
  jobs: 0,
  waiting: 0,
  unavailable: null,
  ...over,
});

describe("an agent's badge", () => {
  test("says what it is doing, waiting for you in the colour that asks for attention", () => {
    expect(statusBadge({ state: "running", activity: activity({}) })).toMatchObject({ label: "idle", tone: "success" });
    expect(statusBadge({ state: "running", activity: activity({ activity: "waiting", waiting: 1 }) })).toMatchObject({ label: "waiting for you", tone: "warning", title: "1 approval waiting on a person" });
    expect(statusBadge({ state: "running", activity: activity({ activity: "working", working: [{ gatewayId: "g", chatId: "1" }], jobs: 2 }) })).toMatchObject({ label: "working", title: "in 1 chat, 2 background jobs" });
    expect(statusBadge({ state: "paused", activity: activity({ activity: "asleep" }) })).toMatchObject({ label: "asleep", title: "Takes no work from anywhere until someone wakes it" });
  });

  test("from an older daemon, the pack's state as before", () => {
    expect(statusBadge({ state: "running" })).toMatchObject({ label: "running", tone: "success" });
    expect(statusBadge({ state: "error" })).toMatchObject({ label: "error", tone: "error" });
  });
});

describe("missions in the badge (0.8.15)", () => {
  test("an agent working on a mission between its turns says so, and an older daemon's status reads as before", () => {
    expect(statusBadge({ state: "running", activity: activity({ activity: "working", missions: 1 }) })).toMatchObject({ label: "working", title: "on 1 mission" });
    expect(statusBadge({ state: "running", activity: activity({ activity: "working", jobs: 1 }) })).toMatchObject({ title: "1 background job" });
    expect(statusBadge({ state: "running", activity: activity({ activity: "waiting", missionsWaiting: 1 }) })).toMatchObject({ label: "waiting for you", title: "1 mission waiting on a person" });
    expect(statusBadge({ state: "running", activity: activity({ activity: "waiting", waiting: 2, missionsWaiting: 1 }) })).toMatchObject({ title: "2 approvals, 1 mission waiting on a person" });
  });
});
