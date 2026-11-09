/**
 * Whether the nightly pass keeps up (`modules/memory/backlog.ts`): what waits, each agent's pace, and the count
 * that would file what waits within a week — and what doctor makes of it. The count stays the owner's limit; this is
 * what tells them it is the one holding a busy box back.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { passBacklogCheck } from "@/cli/commands/doctor-checks.ts";
import { GADING_DM, SAM_DM, at, household, scripted, type Household } from "./fixture.ts";

let h: Household;
afterEach(() => h.close());

/**
 * Thirty conversations with nouva and two with nix over the three days before 23:00 on the 25th, each in a chat of its
 * own — the first at 23:00 on the 22nd, exactly three days before — cut, and none filed yet.
 */
async function busyBox(perNight: number): Promise<void> {
  h = await household();
  h.config.memory.passPerNight = perNight;
  for (let i = 0; i < 30; i += 1) h.dm({ ...GADING_DM, chatId: `n${i}` }, "nouva", `pesan ${i}`, "ok", at(23, 0, 22) + i * 7_000_000);
  for (let i = 0; i < 2; i += 1) h.dm({ ...SAM_DM, chatId: `x${i}` }, "nix", `hai ${i}`, "ok", at(12, i, 24));
  expect(await h.memory.cutAll()).toBe(32);
}

describe("the backlog", () => {
  test("an agent that begins more conversations a day than the pass files a night is behind, with the count that catches up", async () => {
    await busyBox(5);
    expect(h.memory.backlog()).toEqual({
      waiting: 32,
      oldest: "2026-09-22",
      perNight: 5,
      // A box three days old is averaged over its three days: over seven, ten a day would read as four.
      days: 3,
      agents: [
        { agent: "nix", waiting: 2, perDay: 0.7 },
        { agent: "nouva", waiting: 30, perDay: 10 },
      ],
      behind: ["nouva"],
      // Ten a day, and thirty waiting to file within a week: ceil(10 + 30 / 7).
      enough: 15,
    });
  });

  test("a pace the count keeps up with, with more waiting than a week of nights files, still names the count", async () => {
    await busyBox(12);
    expect(h.memory.backlog()).toMatchObject({ behind: [], enough: 15 });
  });

  test("a count that files it all within a week names nothing to set", async () => {
    await busyBox(20);
    expect(h.memory.backlog()).toMatchObject({ waiting: 32, behind: [], enough: null });
  });

  test("what the pass files leaves the waiting, not the pace", async () => {
    await busyBox(5);
    await h.memory.pass(scripted([]).ask);
    // Five a night for each agent: nouva's five and both of nix's.
    expect(h.memory.backlog()).toMatchObject({ waiting: 25, agents: [{ agent: "nix", waiting: 0, perDay: 0.7 }, { agent: "nouva", waiting: 25, perDay: 10 }] });
  });

  test("a week on, the pace is the last seven days'", async () => {
    await busyBox(5);
    h.clock.now += 10 * 86_400_000;
    // Nothing begun in the last seven days: no pace, and thirty-two waiting is five nights' filing — within a week.
    expect(h.memory.backlog()).toMatchObject({ days: 7, agents: [{ agent: "nix", perDay: 0 }, { agent: "nouva", perDay: 0 }], behind: [], enough: null });
  });
});

describe("nouride doctor on it", () => {
  const behind = { waiting: 32, oldest: "2026-09-22", perNight: 5, days: 3, agents: [{ agent: "nix", perDay: 0.7 }, { agent: "nouva", perDay: 10 }], behind: ["nouva"], enough: 15 };

  test("warns with each agent's pace and the count to set, once the count holds the box back", () => {
    expect(passBacklogCheck({ enabled: true }, behind)).toEqual({
      level: "warn",
      message: "memory pass: falling behind, 32 conversation(s) waiting, the oldest from 2026-09-22; nix 0.7 a day, nouva 10 a day over the 3 day(s) since the first conversation, and the pass files 5 per agent a night",
      hint: "`nouride memory set pass_per_night 15` files what waits within a week at this pace; `nouride memory set pass_max_tokens <n>` caps what a night may spend.",
    });
  });

  test("says it keeps up when it does, and nothing for a pass that is off or a daemon too old to say", () => {
    expect(passBacklogCheck({ enabled: true }, { ...behind, behind: [], enough: null })).toEqual({ level: "ok", message: "memory pass: keeping up, 32 conversation(s) waiting, at most 5 per agent a night" });
    expect(passBacklogCheck({ enabled: false }, behind)).toBeNull();
    expect(passBacklogCheck(null, behind)).toBeNull();
    expect(passBacklogCheck({ enabled: true }, undefined)).toBeNull();
  });
});
