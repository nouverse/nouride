/**
 * A coding CLI's mission (0.8.7): its tokens are what the CLI reported over ACP — unknown, never 0, where it reported
 * none — its helpers' tokens are counted too, its limits are time and tokens and not turns, and the page says which hold.
 * And a CLI's mission turn is stopped after an hour without a step, not after an hour.
 */

import { describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@/cli/client.ts";
import { mission as missionCommand } from "@/cli/commands/mission.ts";
import { limitReached, nearLimit } from "@/modules/missions/decide.ts";
import { hoursLimit, limitsLine } from "@/modules/missions/page.ts";
import { outcomeOf } from "@/modules/pipeline/turn-shape.ts";
import { turnClock } from "@/modules/pipeline/turn-clock.ts";
import { missionsHarness } from "./harness.ts";

const cli = (agentId: string) => agentId === "nova";

describe("a CLI turn's tokens, as its outcome", () => {
  const result = { toolCalls: 1, toolSteps: [{ name: "Bash", ok: true }], usage: { inputTokens: 0, outputTokens: 0 } };

  test("reported: the count; not reported: unknown, never taken for 0; a model's turn: its usage", () => {
    expect(outcomeOf({ ...result, externalTokens: 1234 }, false)).toMatchObject({ tokens: 1234 });
    expect(outcomeOf({ ...result, externalTokens: 1234 }, false).tokensUnknown).toBeUndefined();
    expect(outcomeOf({ ...result, externalTokens: null }, false)).toMatchObject({ tokens: 0, tokensUnknown: true });
    expect(outcomeOf({ ...result, usage: { inputTokens: 10, outputTokens: 5 } }, false)).toMatchObject({ tokens: 15 });
  });
});

describe("a CLI mission's count and limits", () => {
  test("the reported tokens are counted; the page says turns are not limited", async () => {
    const h = await missionsHarness({ runsOnCli: cli, settings: { limitTurns: 2 } });
    const mission = await h.start();
    h.turn(mission, { tokens: 5000 });
    expect(h.store.get(mission.id)!.tokensUsed).toBe(5000);
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toBe("turn 2 (a coding CLI's: turns not limited) · 0m of 8h · 5k of 50M tokens");
  });

  test("none reported: tokens unknown, not 0 — and after a restart with nothing heard, unknown too", async () => {
    const h = await missionsHarness({ runsOnCli: cli });
    const mission = await h.start();
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toContain("tokens unknown (the CLI reports none)");
    h.turn(mission, { tokens: 0, tokensUnknown: true });
    const line = h.missions.limitsLine(h.store.get(mission.id)!);
    expect(line).toContain("tokens unknown (the CLI reports none)");
    expect(line).not.toContain("0k of");
  });

  test("reported for some turns only: a floor, said as one", async () => {
    const h = await missionsHarness({ runsOnCli: cli });
    const mission = await h.start();
    h.turn(mission, { tokens: 3000 });
    h.turn(mission, { tokens: 0, tokensUnknown: true });
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toContain("at least 3k of 50M tokens");
  });

  test("past its turn limit a CLI mission goes on; a model's mission stops at it", async () => {
    const h = await missionsHarness({ runsOnCli: cli, settings: { limitTurns: 2, perAgent: 2 } });
    const onCli = await h.start("on the CLI");
    for (let i = 0; i < 3; i += 1) h.turn(onCli, { worked: 1 });
    expect(h.store.get(onCli.id)!.status).toBe("running");
    const onModel = await h.start("on a model", { agentId: "nox" });
    for (let i = 0; i < 2; i += 1) h.turn(onModel, { worked: 1 });
    expect(h.store.get(onModel.id)!.waitKind).toBe("limit");
  });

  test("its tokens still stop it", async () => {
    const h = await missionsHarness({ runsOnCli: cli, settings: { limitTokens: 10_000 } });
    const mission = await h.start();
    h.turn(mission, { tokens: 12_000 });
    expect(h.store.get(mission.id)!.waitKind).toBe("limit");
    expect(h.store.get(mission.id)!.reason).toContain("token limit");
  });

  test("the turn limit is not in force for it; the others are", () => {
    const mission = { turnsUsed: 99, tokensUsed: 0, limits: { turns: 50, tokens: 1000, hours: 8 }, startedAt: 0, endedAt: null, waitedMs: 0, waitingSince: null } as never;
    expect(limitReached(mission, 1, { turns: false })).toBeNull();
    expect(limitReached(mission, 1)).toContain("turn limit");
  });
});

describe("helpers' tokens", () => {
  test("what its helpers spent under its conversation is added at each turn's end, from where the last left off", async () => {
    const asked: number[] = [];
    const h = await missionsHarness({ helperTokens: (_id, since) => (asked.push(since), 700) });
    const mission = await h.start();
    h.tick(1_000);
    h.turn(mission, { tokens: 1000 });
    h.tick(60_000);
    h.turn(mission, { tokens: 1000 });
    expect(h.store.get(mission.id)!.tokensUsed).toBe(3400);
    // From its start, then from the first turn's end — never the same span twice.
    expect(asked).toEqual([mission.startedAt!, mission.startedAt! + 1_000]);
  });
});

describe("a CLI's mission turn is stopped when quiet, not when long", () => {
  /** A hand-wound clock: `advance` moves time and rings what is due. */
  function hand() {
    let now = 0;
    const due = new Map<number, { at: number; fn: () => void }>();
    let next = 0;
    return {
      timers: { set: (fn: () => void, ms: number) => (due.set(++next, { at: now + ms, fn }), next), clear: (handle: unknown) => void due.delete(handle as number) },
      advance(ms: number) {
        now += ms;
        for (const [id, timer] of [...due]) if (timer.at <= now) (due.delete(id), timer.fn());
      },
    };
  }

  test("each step starts the clock again; silence still stops it", () => {
    let aborted = false;
    const h = hand();
    const clock = turnClock(60, () => void (aborted = true), true, h.timers);
    for (let i = 0; i < 4; i += 1) {
      h.advance(30);
      clock.stillWorking();
    }
    expect(aborted).toBe(false);
    h.advance(60);
    expect(aborted).toBe(true);
  });

  test("any other turn is stopped at its time, steps or not", () => {
    let aborted = false;
    const h = hand();
    const clock = turnClock(60, () => void (aborted = true), false, h.timers);
    for (let i = 0; i < 4; i += 1) {
      h.advance(30);
      clock.stillWorking();
    }
    expect(aborted).toBe(true);
    clock.stop();
  });
});

describe("an hours limit, said", () => {
  test("in hours and minutes wherever it is read — the page line, its notices — never as the float it is kept as (0.8.8)", () => {
    // msn_3d28e0's, raised before 0.8.8 and kept so: no migration rounds it, the words do.
    expect(hoursLimit(8.960713333333333)).toBe("8h58m");
    expect(hoursLimit(8)).toBe("8h");
    expect(hoursLimit(1.5)).toBe("1h30m");
    expect(hoursLimit(0.25)).toBe("15m");
    const mission = { turnsUsed: 1, limits: { turns: 101, tokens: 207_600_000, hours: 8.960713333333333 }, tokensUsed: 107_600_000, startedAt: 0, endedAt: null, waitedMs: 0, waitingSince: null, warnedAt: null };
    const now = (2 * 60 + 13) * 60_000;
    expect(limitsLine(mission, now)).toBe("turn 2 of at most 101 · 2h13m of 8h58m · 107.6M of 207.6M tokens");
    const past = 9 * 3_600_000;
    expect(limitReached(mission as never, past, { turns: false })).toBe("its time limit (8h58m of work)");
    expect(nearLimit({ ...mission, tokensUsed: 0 } as never, 8 * 3_600_000, { turns: false })).toBe("its 8h58m of work");
  });

  test("and in `nouride mission show`", async () => {
    const detail = { mission: { id: "msn_1", agentId: "nix", status: "running", waitKind: null, goal: "ship it", checks: [], turnsUsed: 1, limits: { turns: 101, tokens: 207_600_000, hours: 8.960713333333333 }, workedMs: 133 * 60_000, tokensUsed: 107_600_000, reason: null, report: null, files: [], workdir: "/w" }, plan: null, parked: [] };
    const client = { get: async <T>() => detail as T } as unknown as Client;
    const said: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line?: unknown) => void said.push(String(line ?? "")));
    try {
      await missionCommand(client, ["show", "msn_1"]);
    } finally {
      log.mockRestore();
    }
    expect(said.join("\n")).toContain("2h13m of 8h58m");
  });

  test("…whose turn line is the page's: a stopped mission no turn finished in is not \"turn 0 of 100\" (B4, live 0.8.12)", async () => {
    const base = { id: "msn_1", agentId: "nouva", waitKind: null, goal: "an essay", checks: [], limits: { turns: 100, tokens: 100_000_000, hours: 8 }, workedMs: 60_000, tokensUsed: 0, reason: "stopped by cli", report: null, files: [], workdir: "/w", startedAt: 1, waitedMs: 0, waitingSince: null };
    const shown = async (mission: Record<string, unknown>) => {
      const client = { get: async <T>() => ({ mission: { ...base, ...mission }, plan: null, parked: [] }) as T } as unknown as Client;
      const said: string[] = [];
      const log = spyOn(console, "log").mockImplementation((line?: unknown) => void said.push(String(line ?? "")));
      try {
        await missionCommand(client, ["show", "msn_1"]);
      } finally {
        log.mockRestore();
      }
      return said.join("\n");
    };
    const stopped = await shown({ status: "stopped", turnsUsed: 0, endedAt: 2 });
    expect(stopped).toContain("ended before a turn finished (at most 100 turns) · ");
    expect(stopped).not.toContain("turn 0 of 100");
    // Running, the turn it is on — as the page says it; the CLI said the count of those done.
    expect(await shown({ status: "running", turnsUsed: 2, endedAt: null })).toContain("turn 3 of at most 100 · ");
  });
});
