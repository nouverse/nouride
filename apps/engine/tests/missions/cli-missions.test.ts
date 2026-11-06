/**
 * A coding CLI's mission, as 0.8.8 shows and holds it. msn_53b16d ran 1h03m in 2 turns and 215 steps: the dashboard drew
 * "2 of 100" turns, a limit no CLI mission is held to; the ended mission's line said "turn 3"; its hours could not stop
 * the turn it was in, being checked only between turns; and its page told it a delete outside its folder waits for a
 * person, when nothing asks a CLI in the `folder` preset.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MessageEnvelope } from "@nouride/shared";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { missionsHarness } from "./harness.ts";

const cli = (agentId: string) => agentId === "nova";
const HOUR = 3_600_000;

/** The message its next turn would start from, as the queue holds it. */
const envelopeOf = (queued: MessageEnvelope[], missionId: string) => [...queued].reverse().find((one) => one.chatId === missionId)!;

describe("an ended mission's line", () => {
  test("counts the turns that ran — not the one that would have come next", async () => {
    const h = await missionsHarness({ runsOnCli: cli });
    const mission = await h.start();
    h.turn(mission, { tokens: 1000 });
    h.turn(mission, { tokens: 1000 });
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toStartWith("turn 3 (a coding CLI's: turns not limited)");
    h.missions.stop(mission.id, "Gading");
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toStartWith("2 turns ran (a coding CLI's: turns not limited) · ");
  });

  test("…a model's mission too, against its limit, one turn said as one", async () => {
    const h = await missionsHarness();
    const mission = await h.start("on a model", { agentId: "nox" });
    h.turn(mission);
    h.missions.stop(mission.id, "Gading");
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toStartWith("1 turn ran of at most 50 · ");
  });

  test("…and one stopped before any turn finished says so, not \"0 turns ran\"", async () => {
    const h = await missionsHarness();
    const mission = await h.start("on a model", { agentId: "nox" });
    h.missions.stop(mission.id, "Gading");
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toStartWith("ended before a turn finished (at most 50 turns) · ");
  });
});

describe("the hours limit, inside a coding CLI's turn", () => {
  test("a turn running past the hours is stopped at the minute's check, and the mission waits on its limit", async () => {
    const h = await missionsHarness({ runsOnCli: cli, settings: { limitHours: 1 } });
    const mission = await h.start();
    const shape = h.missions.shapeFor("nova", envelopeOf(h.queued, mission.id))!;
    h.tick(30 * 60_000);
    h.missions.tick();
    // Under its hours: the turn goes on.
    expect(h.stopped).toEqual([]);
    expect(h.store.get(mission.id)!.status).toBe("running");
    h.tick(31 * 60_000);
    h.missions.tick();
    expect(h.stopped).toEqual([mission.id]);
    expect(h.store.get(mission.id)).toMatchObject({ status: "waiting", waitKind: "limit", reason: "its time limit (1h of work)" });
    // The stopped turn's end, cut short, counts it and leaves the mission waiting for a person.
    shape.ended({ toolCalls: 215, worked: 215, tokens: 0, tokensUnknown: true, failed: false, interrupted: true, readOutside: false });
    expect(h.store.get(mission.id)).toMatchObject({ status: "waiting", waitKind: "limit", turnsUsed: 1 });
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toStartWith("turn 2 (a coding CLI's: turns not limited) · 1h01m of 1h");
  });

  test("a turn that has just said done, ask or fail is let end — and stopped like any other if it works on (Nox's review)", async () => {
    const h = await missionsHarness({ runsOnCli: cli, settings: { limitHours: 1 } });
    const mission = await h.start();
    h.missions.shapeFor("nova", envelopeOf(h.queued, mission.id));
    h.tick(59 * 60_000);
    h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Done.", files: [] });
    h.tick(2 * 60_000);
    h.missions.tick();
    // Past its hours, a claim two minutes old: the turn is ending, and stopped, what it said would be lost.
    expect(h.stopped).toEqual([]);
    h.tick(10 * 60_000);
    h.missions.tick();
    expect(h.stopped).toEqual([mission.id]);
  });

  test("…a claim said again every few minutes does not put the stop off again (Nox's third review)", async () => {
    const h = await missionsHarness({ runsOnCli: cli, settings: { limitHours: 1 } });
    const mission = await h.start();
    h.missions.shapeFor("nova", envelopeOf(h.queued, mission.id));
    h.tick(59 * 60_000);
    for (let i = 0; i < 3; i += 1) {
      h.missions.claim(mission.id, { kind: "ask", question: "Which branch?" });
      h.tick(5 * 60_000);
    }
    h.missions.tick();
    expect(h.stopped).toEqual([mission.id]);
  });

  test("a model's mission keeps its turn: its limits are checked when the turn ends", async () => {
    const h = await missionsHarness({ settings: { limitHours: 1 } });
    const mission = await h.start("on a model", { agentId: "nox" });
    h.missions.shapeFor("nox", envelopeOf(h.queued, mission.id));
    h.tick(2 * HOUR);
    h.missions.tick();
    expect(h.stopped).toEqual([]);
    expect(h.store.get(mission.id)!.status).toBe("running");
  });
});

describe("going on from a limit the minute's check stopped a CLI turn at (a review of affb384f)", () => {
  test("a continue pressed while the stopped turn is still ending is its next turn — not dropped behind it", async () => {
    // Claude Code takes seconds to end a cancelled prompt; a continue then was dropped for the turn in flight, whose end
    // decides nothing, and the mission sat with no turn until its hour's nudge — the hour counted as worked.
    const h = await missionsHarness({ runsOnCli: cli, settings: { limitHours: 1 } });
    const mission = await h.start();
    const shape = h.missions.shapeFor("nova", envelopeOf(h.queued, mission.id))!;
    h.tick(61 * 60_000);
    h.missions.tick();
    const before = h.queued.length;
    h.missions.continueMission(mission.id, "Gading");
    expect(h.queued.length).toBe(before + 1);
    expect(h.queued.at(-1)!.text).toContain("Gading said to go on");
    h.tick(5_000);
    shape.ended({ toolCalls: 3, worked: 3, tokens: 0, tokensUnknown: true, failed: false, interrupted: true, readOutside: false });
    // The queued continue runs once the stopped turn is out of the way.
    expect(h.missions.shapeFor("nova", h.queued.at(-1)!)).not.toBeNull();
  });

  test("a stop that lands as the turn finishes says the limit once, and a claim it made then leaves it waiting", async () => {
    const h = await missionsHarness({ runsOnCli: cli, settings: { limitHours: 1 } });
    const mission = await h.start();
    const shape = h.missions.shapeFor("nova", envelopeOf(h.queued, mission.id))!;
    h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Done.", files: [] });
    h.tick(61 * 60_000);
    h.missions.tick();
    // The turn had already found it was not stopped: its end comes as an ordinary one.
    shape.ended({ toolCalls: 3, worked: 3, tokens: 0, tokensUnknown: true, failed: false, interrupted: false, readOutside: false });
    expect(h.told.filter((one) => one.text.startsWith("⏸"))).toHaveLength(1);
    expect(h.store.get(mission.id)).toMatchObject({ status: "waiting", waitKind: "limit", turnsUsed: 1 });
  });
});

describe("the token limit, inside a coding CLI's turn (0.8.8)", () => {
  // msn_3d28e0: one CLI turn ran from 107.6M to 247.8M of a 207.6M limit — a CLI says what a prompt spent only when it
  // ends, and the limit read nothing else.
  test("a turn whose running estimate passes the tokens is stopped at the minute's check — the words marked as an estimate", async () => {
    let running = 0;
    const h = await missionsHarness({ runsOnCli: cli, runningTokens: () => running });
    const mission = await h.start();
    const shape = h.missions.shapeFor("nova", envelopeOf(h.queued, mission.id))!;
    running = 30_000_000;
    h.tick(60_000);
    h.missions.tick();
    expect(h.stopped).toEqual([]);
    running = 50_400_000;
    h.tick(60_000);
    h.missions.tick();
    expect(h.stopped).toEqual([mission.id]);
    expect(h.store.get(mission.id)).toMatchObject({
      status: "waiting",
      waitKind: "limit",
      reason: "its token limit (50M tokens; about 50.4M so far, by what its CLI said while it worked)",
    });
    expect(h.told.at(-1)!.text).toContain(`/mission continue ${mission.id.slice(0, 10)} gives it 50M more tokens,`);
    // The stopped turn's end brings the count the CLI gives, in place of the estimate.
    shape.ended({ toolCalls: 300, worked: 300, tokens: 51_000_000, failed: false, interrupted: true, readOutside: false });
    expect(h.store.get(mission.id)).toMatchObject({ status: "waiting", tokensUsed: 51_000_000 });
    expect(h.told.filter((one) => one.text.startsWith("⏸")).length).toBe(1);
    // Going on raises the tokens from where it stands, and the hours not at all.
    h.missions.continueMission(mission.id, "Gading");
    expect(h.store.get(mission.id)!.limits).toMatchObject({ tokens: 101_000_000, hours: 8 });
  });

  test("read as its CLI says what it spent, not only each minute — at most every few seconds", async () => {
    // Live, 0.8.8's first build: Claude Code spent 1M tokens in the minute between two checks, and a turn with 1M left
    // ended 1.1M past its limit.
    let running = 30_000_000;
    const h = await missionsHarness({ runsOnCli: cli, runningTokens: () => running });
    const mission = await h.start();
    h.missions.shapeFor("nova", envelopeOf(h.queued, mission.id));
    h.missions.spent(mission.id);
    expect(h.stopped).toEqual([]);
    running = 50_400_000;
    // Two seconds on: the CLI says it several times a model call, and the limits are read again only seconds apart.
    h.tick(2_000);
    h.missions.spent(mission.id);
    expect(h.stopped).toEqual([]);
    h.tick(3_000);
    h.missions.spent(mission.id);
    expect(h.stopped).toEqual([mission.id]);
    expect(h.store.get(mission.id)).toMatchObject({ status: "waiting", waitKind: "limit" });
    // Once it waits, what the ending turn still says reads nothing again.
    h.tick(10_000);
    h.missions.spent(mission.id);
    expect(h.stopped).toEqual([mission.id]);
    expect(h.told.filter((one) => one.text.startsWith("⏸"))).toHaveLength(1);
  });

  test("its helpers' tokens not counted yet are read with it", async () => {
    const h = await missionsHarness({ runsOnCli: cli, runningTokens: () => 30_000_000, helperTokens: () => 25_000_000 });
    const mission = await h.start();
    h.missions.shapeFor("nova", envelopeOf(h.queued, mission.id));
    h.tick(60_000);
    h.missions.tick();
    expect(h.stopped).toEqual([mission.id]);
    expect(h.store.get(mission.id)!.reason).toBe("its token limit (50M tokens; about 55M so far, by what its CLI said while it worked)");
  });

  test("a count that comes in under the limit still gives it the tokens on going on — the stop read them reached", async () => {
    let running = 50_400_000;
    const h = await missionsHarness({ runsOnCli: cli, runningTokens: () => running });
    const mission = await h.start();
    const shape = h.missions.shapeFor("nova", envelopeOf(h.queued, mission.id))!;
    h.tick(60_000);
    h.missions.tick();
    running = 0;
    shape.ended({ toolCalls: 300, worked: 300, tokens: 49_000_000, failed: false, interrupted: true, readOutside: false });
    h.missions.continueMission(mission.id, "Gading");
    expect(h.store.get(mission.id)!.limits.tokens).toBe(99_000_000);
  });

  test("a model's turn is not stopped by an estimate: none runs, and its tokens are counted when it ends", async () => {
    const h = await missionsHarness({ runningTokens: () => 60_000_000 });
    const mission = await h.start("on a model", { agentId: "nox" });
    h.missions.shapeFor("nox", envelopeOf(h.queued, mission.id));
    h.tick(60_000);
    h.missions.tick();
    expect(h.stopped).toEqual([]);
  });
});

describe("the delete rule on its page", () => {
  const RULE = /^- Delete with a command of its own.*$/m;

  test("a CLI nothing asks before a delete is told so, and that its user's rights are the limit", async () => {
    const h = await missionsHarness({ runsOnCli: cli, freeToDelete: cli });
    const mission = await h.start();
    const rule = RULE.exec(h.missions.shapeFor("nova", envelopeOf(h.queued, mission.id))!.text)?.[0];
    expect(rule).toContain("`rm -rf <absolute path>` alone");
    expect(rule).toContain("Nothing asks before a delete you run, inside this mission's folder or outside it");
    expect(rule).toContain("your Linux user's rights are the only limit");
    expect(rule).not.toContain("waits for a person");
  });

  test("an agent the approvals hold — its own model's, or a CLI that asks — keeps today's rule", async () => {
    const h = await missionsHarness({ runsOnCli: cli, freeToDelete: () => false, settings: { perAgent: 2, maxRunning: 4 } });
    for (const agentId of ["nova", "nox"]) {
      const mission = await h.start(`for ${agentId}`, { agentId });
      const rule = RULE.exec(h.missions.shapeFor(agentId, envelopeOf(h.queued, mission.id))!.text)?.[0];
      expect(rule).toBe(
        "- Delete with a command of its own, never chained into another: `rm -rf <absolute path>` alone. A delete inside this mission's folder, by absolute path, runs without asking anyone; a chained one, or one outside, waits for a person.",
      );
    }
  });
});

describe("how a mission works, as the page tells its agent", () => {
  test("a CLI is told it remembers its earlier turns — an agent on a model that each turn starts from the page", async () => {
    // HARDENING §5: the page told every agent "every turn starts from this page, not from your last turn"; a coding CLI
    // keeps one session for the whole mission, so it was told something untrue about itself.
    const h = await missionsHarness({ runsOnCli: cli, settings: { perAgent: 2, maxRunning: 4 } });
    const onCli = await h.start("for nova", { agentId: "nova" });
    const onModel = await h.start("for nox", { agentId: "nox" });
    const cliPage = h.missions.shapeFor("nova", envelopeOf(h.queued, onCli.id))!.text;
    const modelPage = h.missions.shapeFor("nox", envelopeOf(h.queued, onModel.id))!.text;
    expect(cliPage).toContain("Your session lasts the whole mission, so you remember your earlier turns; this page is where the mission stands now");
    expect(cliPage).not.toContain("every turn starts from this page");
    expect(modelPage).toContain("HOW A MISSION WORKS. Nobody is reading along, and every turn starts from this page, not from your last turn:");
    expect(modelPage).not.toContain("you remember your earlier turns");
  });

  test("every agent is told on its page which files go to the person — never what checked the work", async () => {
    // Live, 0.8.12: with the rule only in the `files` field's description, Nouva still sent its evidence file beside the summary.
    const h = await missionsHarness({ runsOnCli: cli, settings: { perAgent: 2, maxRunning: 4 } });
    for (const agentId of ["nova", "nox"]) {
      const mission = await h.start(`for ${agentId}`, { agentId });
      expect(h.missions.shapeFor(agentId, envelopeOf(h.queued, mission.id))!.text).toContain(
        "and the files the person should receive: what they asked for, never what you made to check the work (evidence, stills, fixtures, an answer key: the report names those).",
      );
    }
  });
});

describe("what the dashboard reads", () => {
  test("each mission says which limits hold and whether its tokens are known — a list row and its page alike", async () => {
    const h = await missionsHarness({ runsOnCli: cli, settings: { perAgent: 2, maxRunning: 4 } });
    const control = new Hono<{ Variables: { principal: unknown } }>();
    control.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "operator", role: "operator", user: { id: "usr_1", username: "op", displayName: "op" } });
      await next();
    });
    registerMissionRoutes(control as never, { missions: h.missions, notes: h.notes, approvals: { pending: () => [] }, audit: { record: () => {} } } as never);
    const onCli = await h.start("on the CLI");
    const onModel = await h.start("on a model", { agentId: "nox" });
    h.turn(onCli, { tokens: 3000 });
    h.turn(onCli, { tokens: 0, tokensUnknown: true });
    const list = (await (await control.request("/missions")).json()) as { missions: { id: string; shown: unknown }[] };
    expect(Object.fromEntries(list.missions.map((one) => [one.id, one.shown]))).toEqual({
      [onCli.id]: { turns: false, tokens: "partial" },
      [onModel.id]: { turns: true, tokens: "known" },
    });
    const one = (await (await control.request(`/missions/${onCli.id}`)).json()) as { mission: { shown: unknown } };
    expect(one.mission.shown).toEqual({ turns: false, tokens: "partial" });
  });
});
