/**
 * Whether anyone could actually answer an approval.
 *
 * The bug this closes: `canAsk` was "is any gateway connected", and the local gateway is an in-process
 * object that reports `connected` unconditionally. So on every install with a CLI or a dashboard —
 * which is every install — the answer was always yes, `ask_fallback = "deny"` never applied, and an
 * unattended tool call parked for the full five-minute timeout before expiring as the denial it would
 * have been immediately.
 */

import { describe, expect, test } from "bun:test";
import { ApprovalReach } from "@/modules/tools/reachability.ts";

function at(clock: { now: number }): ApprovalReach {
  return new ApprovalReach(() => clock.now);
}

describe("ApprovalReach", () => {
  test("a connected chat gateway is enough on its own", () => {
    // A prompt would land in front of a person on Telegram or Discord whether or not anyone has a CLI
    // open.
    const clock = { now: 1_000_000 };
    expect(at(clock).canAsk(true)).toBe(true);
  });

  test("nothing watching and no chat gateway means nobody can answer", () => {
    // The case the whole fix is for: three in the morning, no CLI, no browser, no bot.
    const clock = { now: 1_000_000 };
    expect(at(clock).canAsk(false)).toBe(false);
  });

  test("a recent poll counts as somebody being there, and goes stale", () => {
    // A client asking for pending approvals is a client that would show one. That is the only
    // evidence available, and it is direct rather than inferred.
    const clock = { now: 1_000_000 };
    const reach = at(clock);
    reach.notePoll();

    clock.now += 29_000;
    expect(reach.canAsk(false)).toBe(true);

    clock.now += 5_000;
    expect(reach.canAsk(false)).toBe(false);
  });

  test("a fresh instance has never been polled", () => {
    // Guards against a zero-initialised timestamp reading as "polled at the epoch, which is within
    // the window of a clock that also starts at zero".
    const clock = { now: 0 };
    expect(at(clock).hasWatcher()).toBe(false);
  });
});
