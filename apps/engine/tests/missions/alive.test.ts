/**
 * A long turn shows it is alive. A coding CLI's mission is one turn of hours, and everything said of it was written at
 * a turn's end: its tokens read "unknown" for all of it, the 80% notice never came before the limit stopped it, and its
 * record's own "updated" stood at its start.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Client } from "@nouride/cli-kit";
import { mission as missionCommand } from "../../../cli/src/commands/mission.ts";
import type { MissionView } from "@nouride/wire";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { missionsHarness, STARTERS_CTX } from "./harness.ts";

const cli = (agentId: string) => agentId === "nova";

describe("what a turn at work has spent so far", () => {
  test("is in the limits' line as an estimate, where it said unknown, and never as a count", async () => {
    let spent = 0;
    const h = await missionsHarness({ runsOnCli: cli, runningTokens: () => spent });
    const mission = await h.start();
    // Nothing said by its CLI yet: unknown, as before.
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toEndWith("tokens unknown (the CLI reports none) of 50M");
    spent = 26_742_673;
    expect(h.missions.limitsShown(h.store.get(mission.id)!)).toEqual({ turns: false, tokens: "unknown", running: 26_742_673 });
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toEndWith("about 26.7M of 50M tokens so far (an estimate while its turn is at work)");
    // The record itself holds none of it until the turn ends.
    expect(h.store.get(mission.id)!.tokensUsed).toBe(0);
  });

  test("is added to what earlier turns counted, and gone once no turn is at work", async () => {
    let spent = 0;
    const h = await missionsHarness({ runsOnCli: cli, runningTokens: () => spent });
    const mission = await h.start();
    h.turn(mission, { tokens: 10_000_000 });
    spent = 5_000_000;
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toEndWith("about 15M of 50M tokens so far (an estimate while its turn is at work)");
    // Waiting on a person, nothing is at work: its count alone, whatever a stale reading says.
    h.missions.wait(h.store.get(mission.id)!, "limit", "its token limit");
    expect(h.missions.limitsShown(h.store.get(mission.id)!)).toEqual({ turns: false, tokens: "known" });
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toEndWith("10M of 50M tokens");
  });

  test("`nouride mission show` says it the same way, and its count where the daemon sends no estimate", async () => {
    const view = { id: "msn_1", agentId: "nix", status: "running", waitKind: null, goal: "ship it", checks: [], turnsUsed: 0, limits: { turns: 10, tokens: 100_000_000, hours: 8 }, workedMs: 70 * 60_000, tokensUsed: 0, reason: null, report: null, files: [], answers: [], told: [], workdir: "/w" };
    let detail: unknown = { mission: { ...view, shown: { turns: false, tokens: "unknown", running: 26_742_673 } }, plan: null, parked: [] };
    const client = { get: async () => detail } as unknown as Client;
    const printed: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line?: unknown) => void printed.push(String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "")));
    let before = "";
    try {
      await missionCommand(client, ["show", "msn_1"]);
      before = printed.join("\n");
      printed.length = 0;
      detail = { mission: { ...view, tokensUsed: 1_300_000 }, plan: null, parked: [] };
      await missionCommand(client, ["show", "msn_1"]);
    } finally {
      log.mockRestore();
    }
    expect(before).toContain("about 26.7M of 100.0M tokens so far (an estimate while its turn is at work)");
    expect(printed.join("\n")).toContain("1.3M of 100.0M tokens");
    expect(printed.join("\n")).not.toContain("estimate");
  });

  test("a mission on a model has none: its turns are counted as they end", async () => {
    const h = await missionsHarness({ runningTokens: () => 9_000_000 });
    const mission = await h.start();
    expect(h.missions.limitsShown(h.store.get(mission.id)!)).toEqual({ turns: true, tokens: "known" });
  });
});

describe("80% of a limit, inside a turn at work", () => {
  test("is said from inside the turn, once, and not again at its end", async () => {
    let spent = 30_000_000;
    const h = await missionsHarness({ runsOnCli: cli, runningTokens: () => spent });
    const mission = await h.start();
    const warned = () => h.told.filter((one) => one.text.includes("has used 80% of"));
    // Its turn is at work, and stays so over the ticks.
    const shape = h.missions.shapeFor("nova", h.queued.at(-1)!)!;
    h.missions.tick();
    expect(warned()).toEqual([]);
    spent = 41_000_000;
    h.missions.tick();
    expect(warned().map((one) => one.text)).toEqual([`Mission ${mission.id.slice(0, 10)} has used 80% of its 50M tokens.`]);
    // Kept on the record, so a restart does not say it again.
    expect(h.store.get(mission.id)!.warnedAt).not.toBeNull();
    h.missions.tick();
    spent = 0;
    shape.ended({ toolCalls: 3, worked: 3, tokens: 41_500_000, failed: false, interrupted: false, readOutside: false });
    expect(warned()).toHaveLength(1);
    expect(h.store.get(mission.id)!.status).toBe("running");
  });

  test("at the limit itself the turn is stopped and the limit alone is said", async () => {
    const h = await missionsHarness({ runsOnCli: cli, runningTokens: () => 50_000_000 });
    const mission = await h.start();
    h.missions.shapeFor("nova", h.queued.at(-1)!);
    h.missions.tick();
    expect(h.told.filter((one) => one.text.includes("has used 80% of"))).toEqual([]);
    expect(h.store.get(mission.id)!).toMatchObject({ status: "waiting", waitKind: "limit" });
  });

  test("with no turn at work it is left to the next turn's end: a mission waiting on its job is read by none", async () => {
    const h = await missionsHarness({ runsOnCli: cli, runningTokens: () => 45_000_000 });
    const mission = await h.start();
    // Its job still runs, so no next turn is queued: nothing of it is in flight.
    h.jobs.set("nova", [{ id: "job_1", gatewayId: "web:mission", chatId: mission.id }]);
    h.turn(mission, { tokens: 1000 });
    expect(h.missions.inFlight(h.store.get(mission.id)!)).toBe(false);
    h.missions.tick();
    expect(h.told.filter((one) => one.text.includes("has used 80% of"))).toEqual([]);
  });
});

describe("when a mission at work last did something", () => {
  const app = (h: Awaited<ReturnType<typeof missionsHarness>>, running: { startedAt: number; steps: { at: number }[] }[]) => {
    const control = new Hono<{ Variables: { principal: unknown } }>();
    control.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "operator", role: "operator", user: { id: "usr_operator", username: "operator", displayName: "Gading" } });
      await next();
    });
    const asked: string[] = [];
    registerMissionRoutes(control as never, {
      ctx: STARTERS_CTX,
      missions: h.missions,
      notes: h.notes,
      approvals: { pending: () => [] },
      audit: { record: () => {} },
      turns: { runningForChat: (gatewayId: string, chatId: string) => (asked.push(`${gatewayId}:${chatId}`), running), stepsIn: () => 0 },
    } as never);
    return { control, asked };
  };

  test("is on its view: the newest step of its turn at work, or that turn's start; absent for one not at work", async () => {
    const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 } });
    const working = await h.start("the viewers");
    const waiting = await h.start("the room");
    h.missions.wait(h.store.get(waiting.id)!, "limit", "its time limit");
    const { control, asked } = app(h, [{ startedAt: 1_000, steps: [{ at: 1_500 }, { at: 9_000 }, { at: 4_000 }] }]);
    const { missions } = (await (await control.request("/missions")).json()) as { missions: MissionView[] };
    expect(missions.find((one) => one.id === working.id)!.activeAt).toBe(9_000);
    expect(missions.find((one) => one.id === waiting.id)).not.toHaveProperty("activeAt");
    // Asked of the mission's own conversation, and only for one at work.
    expect(asked).toEqual([`web:mission:${working.id}`]);
    const detail = (await (await control.request(`/missions/${working.id}`)).json()) as { mission: MissionView };
    expect(detail.mission.activeAt).toBe(9_000);
  });

  test("a turn at work that has taken no step yet: its start", async () => {
    const h = await missionsHarness();
    const working = await h.start();
    const { control } = app(h, [{ startedAt: 7_000, steps: [] }]);
    const { missions } = (await (await control.request("/missions")).json()) as { missions: MissionView[] };
    expect(missions[0]).toMatchObject({ id: working.id, activeAt: 7_000 });
    const none = app(h, []);
    expect(((await (await none.control.request("/missions")).json()) as { missions: MissionView[] }).missions[0]).not.toHaveProperty("activeAt");
  });
});
