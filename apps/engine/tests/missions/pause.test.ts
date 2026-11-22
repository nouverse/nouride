/**
 * A mission paused, and gone on with whenever (`missions/person.ts` `pauseMission`).
 *
 * A mission at work could only be stopped for good. Paused, its turn is cut and its background jobs ended, its agent's
 * slot is free, and its checklist, its folder and its repository are kept; the time it is paused counts against no
 * limit and draws no reminder, and `continue` goes on from its checklist at any time. For a mission that is running or
 * queued; said by whoever may stop it, and by the orchestrator for any agent's mission, through `work`.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Client } from "@nouride/cli-kit";
import type { ToolContext } from "@nouride/shared";
import { mission as missionCommand } from "../../../cli/src/commands/mission.ts";
import { missionHooks } from "@/modules/hooks/builtins/mission.ts";
import type { HookContext } from "@/modules/hooks/types.ts";
import { ActionPresses } from "@/modules/missions/actions.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { FOLLOW_UP_MS, LIMIT_WAIT_MS } from "@/modules/missions/limits.ts";
import { workedMs } from "@/modules/missions/page.ts";
import type { Mission } from "@/modules/missions/types.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { createWorkTool } from "@/modules/tools/builtins/work.ts";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { missionsHarness, STARTERS_CTX } from "./harness.ts";

type Harness = Awaited<ReturnType<typeof missionsHarness>>;
const HOUR = 60 * 60_000;
const short = (mission: Pick<Mission, "id">) => mission.id.slice(0, 10);
const now = (h: Harness, mission: Mission) => h.store.get(mission.id)!;
const OUTCOME = { toolCalls: 1, worked: 1, tokens: 1000, failed: false, interrupted: false, readOutside: false };

describe("a mission paused in the middle of a turn", () => {
  test("waits as paused: its turn cut, its jobs ended, who paused it kept, and the turn's end decides nothing", async () => {
    const h = await missionsHarness();
    const mission = await h.start("write the report", { checks: ["test -s out.md"] });
    let checked = 0;
    h.setChecks(async () => (checked++, { passed: true, failed: null }));
    h.jobs.set("nova", [
      { id: "job_build", gatewayId: MISSION_GATEWAY_ID, chatId: mission.id },
      { id: "job_serve", gatewayId: MISSION_GATEWAY_ID, chatId: mission.id, service: true },
      { id: "job_chat", gatewayId: "telegram:nova", chatId: "8142" },
    ]);
    // Its turn is at work: the shape is taken, and ends only below.
    const shape = h.missions.shapeFor("nova", h.queued.at(-1)!)!;
    const queued = h.queued.length;

    expect(h.missions.pause(mission.id, "Gading")).toMatchObject({ mission: { status: "waiting", waitKind: "paused", pausedBy: "Gading", pausedByAgent: null } });
    expect(h.stopped).toEqual([mission.id]);
    // Every job of its own, a server among them, as reaching a limit ends them; never a job of the agent's chat.
    expect(h.killed).toEqual(["job_build", "job_serve"]);
    expect(now(h, mission)).toMatchObject({ status: "waiting", waitKind: "paused", reason: "paused by Gading", pausedBy: "Gading" });

    // The turn that was cut ends after the pause, and had even said done on its way: nothing of it is acted on.
    h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Wrote it.", files: [] });
    shape.ended({ ...OUTCOME, interrupted: true });
    await h.settle();
    expect(now(h, mission)).toMatchObject({ status: "waiting", waitKind: "paused", turnsUsed: 1 });
    expect(checked).toBe(0);
    expect(h.queued.length).toBe(queued);

    // Said once, in its own words, with what a person can do about it.
    const notices = h.told.filter((one) => one.text.includes("is paused by"));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toBe(
      `⏸ write the report (${short(mission)}) is paused by Gading. Its work so far and its folder are kept, and the time it is paused is not counted.\n\n/mission continue ${short(mission)} goes on from its checklist, whenever you like · /mission stop ${short(mission)} ends it.`,
    );
    expect(notices[0]!.buttons!.map((button) => button.label)).toEqual(["Resume", "Stop"]);
    expect(h.missions.forStatus("nova")).toEqual({ atWork: 0, waiting: 1 });
  });

  test("its agent's slot is free: the next mission of that agent starts at once", async () => {
    const h = await missionsHarness({ settings: { perAgent: 1, maxRunning: 1 } });
    const first = await h.start("the first");
    const second = await h.start("the second");
    expect(now(h, second).status).toBe("queued");
    h.missions.pause(first.id, "Gading");
    await h.settle();
    expect(now(h, second).status).toBe("running");
  });

  test("it keeps its repository: a mission in the same folder waits until it goes on and ends, or is stopped", async () => {
    const h = await missionsHarness({ settings: { perAgent: 2, maxRunning: 2 } });
    const first = await h.start("the first", { workdir: "/repos/site" });
    h.missions.pause(first.id, "Gading");
    const second = await h.start("the second", { workdir: "/repos/site" });
    expect(now(h, second).status).toBe("queued");
    expect(h.told.at(-1)!.text).toContain(`${short(first)} is working in the same folder (/repos/site)`);
    h.missions.stop(first.id, "Gading");
    await h.settle();
    expect(now(h, second).status).toBe("running");
  });

  test("continue gives it a turn from its checklist, told its last turn was cut; who paused it is let go", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.turn(mission);
    h.missions.pause(mission.id, "Gading");
    expect(h.missions.continueMission(mission.id, "Sam", "the staging box is back")).toMatchObject({ mission: { status: "running", waitKind: null, pausedBy: null } });
    expect(h.queued.at(-1)!.text).toBe(
      "Sam said to go on after a pause (Gading paused it): the staging box is back The turn you were in was cut off and your background jobs were ended. Go on from your checklist: look at what the step you were on left before you repeat it, and start again any job you still need.",
    );
    // And the turn runs: the mission is at work again.
    expect(h.turn(now(h, mission))).not.toBeNull();
    expect(now(h, mission).status).toBe("running");
  });

  test("the Resume button under its notice goes on, and Stop ends it", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.missions.pause(mission.id, "Gading");
    const presses = new ActionPresses({ missions: h.missions, isAdmin: () => false });
    const [resume] = h.told.at(-1)!.buttons!;
    const pressed = await presses.press({ data: resume!.data, gatewayId: "telegram:nova", chatId: "8142", chatType: "dm", senderId: "8142", senderName: "Gading" } as never);
    expect(pressed.notice).toBe(`write the report (${short(mission)}) told to go on.`);
    expect(now(h, mission).status).toBe("running");
  });
});

describe("the time a mission is paused", () => {
  test("is not in its hours, reaches no limit, draws no reminder and never ends it", async () => {
    const h = await missionsHarness({ settings: { limitHours: 2 } });
    const mission = await h.start();
    h.tick(HOUR);
    h.turn(mission);
    h.missions.pause(mission.id, "Gading");
    const told = h.told.length;
    // Longer than its hours limit, than the reminder of a wait, and than the week a limit waits before it fails.
    for (const wait of [3 * HOUR, FOLLOW_UP_MS, LIMIT_WAIT_MS]) {
      h.tick(wait);
      h.missions.tick();
      await h.settle();
      expect(now(h, mission)).toMatchObject({ status: "waiting", waitKind: "paused" });
    }
    expect(h.told.length).toBe(told);
    expect(workedMs(now(h, mission), h.now())).toBe(HOUR);

    h.missions.continueMission(mission.id, "Gading");
    expect(now(h, mission)).toMatchObject({ status: "running" });
    expect(workedMs(now(h, mission), h.now())).toBe(HOUR);
    // Nothing reached: the minute's check leaves it at work.
    h.missions.tick();
    expect(now(h, mission).status).toBe("running");
  });
});

describe("a queued mission paused", () => {
  test("does not start when a slot frees; continued, it is queued again and starts when one is free", async () => {
    const h = await missionsHarness({ settings: { perAgent: 1, maxRunning: 1 } });
    const first = await h.start("the first");
    const second = await h.start("the second");
    expect(h.missions.pause(second.id, "Gading")).toMatchObject({ mission: { status: "waiting", waitKind: "paused", startedAt: null } });
    // Nothing of it ran, so nothing was cut.
    expect(h.stopped).toEqual([]);
    h.missions.stop(first.id, "Gading");
    await h.settle();
    expect(now(h, second)).toMatchObject({ status: "waiting", waitKind: "paused", startedAt: null });

    const third = await h.start("the third");
    expect(now(h, third).status).toBe("running");
    h.tick(5 * HOUR);
    expect(h.missions.continueMission(second.id, "Gading")).toMatchObject({ mission: { status: "queued" } });
    expect(now(h, second)).toMatchObject({ status: "queued", pausedBy: null });
    h.missions.stop(third.id, "Gading");
    await h.settle();
    const started = now(h, second);
    expect(started.status).toBe("running");
    // The hours before it started are not time it waited while working.
    expect(started.waitedMs).toBe(0);
    expect(h.queued.at(-1)!.text).toContain("the mission starts");
  });

  test("accepted as it stands is refused: nothing of it ran", async () => {
    const h = await missionsHarness({ settings: { perAgent: 1, maxRunning: 1 } });
    await h.start("the first");
    const second = await h.start("the second");
    h.missions.pause(second.id, "Gading");
    expect(h.missions.accept(second.id, "Gading")).toMatchObject({ why: "not-started" });
    expect(now(h, second)).toMatchObject({ status: "waiting", waitKind: "paused" });
  });
});

describe("what is not paused", () => {
  test("one being checked, one waiting for a person, a draft, one already paused and one that ended: each refused with why", async () => {
    const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 } });
    const checking = await h.start("checked", { checks: ["test -s out.md"] });
    h.setChecks(() => new Promise(() => {}));
    h.turn(checking, {}, () => h.missions.claim(checking.id, { kind: "done", summary: "Done.", report: "r", files: [] }));
    await h.settle();
    expect(h.missions.pause(checking.id, "Gading")).toMatchObject({ why: "checking" });

    const asking = await h.start("asking");
    h.turn(asking, {}, () => void h.missions.ask(asking.id, { question: "Which?" }));
    expect(h.missions.pause(asking.id, "Gading")).toMatchObject({ why: "waiting", refused: `Mission ${short(asking)} is waiting for a person already (input), and nothing of it is running to pause.` });

    const draft = await h.start("a draft", { proposed: true });
    expect(h.missions.pause(draft.id, "Gading")).toMatchObject({ why: "not-started" });

    const paused = await h.start("paused");
    h.missions.pause(paused.id, "Gading");
    expect(h.missions.pause(paused.id, "Sam")).toMatchObject({ why: "paused", refused: `Mission ${short(paused)} is already paused, by Gading. To go on: /mission continue ${short(paused)}.` });
    expect(now(h, paused).pausedBy).toBe("Gading");

    const ended = await h.start("ended");
    h.missions.stop(ended.id, "Gading");
    expect(h.missions.pause(ended.id, "Gading")).toMatchObject({ why: "ended" });
    expect(h.missions.pause("msn_nothere", "Gading")).toMatchObject({ why: "missing" });
  });

  test("a paused one that had started can still be accepted as it stands, or told something for when it goes on", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.turn(mission);
    h.missions.pause(mission.id, "Gading");
    expect(h.missions.tell(mission.id, "use the new sheet", "Gading")).toMatchObject({ where: "paused", said: `Kept for its next turn. It is paused: /mission continue ${short(mission)} lets it go on, with this read first.` });
    expect(h.missions.accept(mission.id, "Gading")).toMatchObject({ mission: { status: "done", reason: "accepted by Gading as it stood" } });
  });
});

describe("pause through `work`", () => {
  const setup = async (orchestrator: string | null = "nova") => {
    const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 }, agents: ["nova", "nox", "kuro"] });
    const tool = createWorkTool({
      missions: h.missions,
      plan: () => undefined,
      jobs: { list: () => [], get: () => null, tail: async () => "", kill: () => false },
      approvals: new SqliteApprovalGate({ db: h.db, timeoutMs: 60_000 }),
      orchestrator: () => orchestrator ?? undefined,
    });
    const call = (agentId: string, args: Record<string, unknown>) => tool.execute(args, { agentId, gatewayId: "telegram:nova", chatId: "8142", senderId: "8142" } as ToolContext);
    return { h, call, tool };
  };

  test("the orchestrator pauses another agent's mission; an agent that is not the orchestrator cannot, and reads it as not there", async () => {
    const { h, call } = await setup();
    const theirs = await h.start("nox's own", { agentId: "nox" });
    const refused = await call("kuro", { action: "pause", id: theirs.id });
    expect(refused).toMatchObject({ isError: true, content: `No mission ${theirs.id} of yours.` });
    expect(now(h, theirs).status).toBe("running");

    const paused = await call("nova", { action: "pause", id: short(theirs) });
    expect(paused.isError).toBe(false);
    expect(paused.content).toBe(`Mission ${short(theirs)} (nox) is paused: its turn is cut, its background jobs are ended, and its work and folder are kept. \`resume\` goes on with it; its person can too.`);
    expect(now(h, theirs)).toMatchObject({ status: "waiting", waitKind: "paused", pausedBy: "agent nova", pausedByAgent: "nova" });
    // Listing and stopping stay each agent's own: the orchestrator reaches it for a pause and nothing else.
    expect((await call("nova", { action: "stop", id: theirs.id })).isError).toBe(true);
    expect((await call("nova", { action: "missions" })).content).not.toContain(short(theirs));
  });

  test("with no orchestrator named, nobody pauses another's", async () => {
    const { h, call } = await setup(null);
    const theirs = await h.start("nox's own", { agentId: "nox" });
    expect((await call("nova", { action: "pause", id: theirs.id })).isError).toBe(true);
    expect(now(h, theirs).status).toBe("running");
  });

  test("the orchestrator goes on with one it paused itself, and not with a person's pause", async () => {
    const { h, call } = await setup();
    const byIt = await h.start("paused by nova", { agentId: "nox" });
    const byPerson = await h.start("paused by a person", { agentId: "nox" });
    await call("nova", { action: "pause", id: byIt.id });
    h.missions.pause(byPerson.id, "Gading");

    const person = await call("nova", { action: "resume", id: byPerson.id });
    expect(person).toMatchObject({ isError: true, content: `No mission ${byPerson.id} of yours.` });
    expect(now(h, byPerson)).toMatchObject({ status: "waiting", waitKind: "paused", pausedBy: "Gading" });

    const own = await call("nova", { action: "resume", id: byIt.id });
    expect(own).toMatchObject({ isError: false, content: `Mission ${short(byIt)} goes on from its checklist.` });
    expect(now(h, byIt)).toMatchObject({ status: "running", pausedByAgent: null });
    expect(h.queued.at(-1)!.text).toStartWith("agent nova said to go on after a pause (agent nova paused it).");
  });

  test("an agent pauses and resumes its own mission; a pause a person made on it is the person's to end", async () => {
    const { h, call } = await setup();
    const own = await h.start("kuro's own", { agentId: "kuro" });
    expect((await call("kuro", { action: "pause", id: own.id })).isError).toBe(false);
    expect((await call("kuro", { action: "missions" })).content).toContain(`${short(own)} · kuro · paused by agent kuro`);
    expect((await call("kuro", { action: "resume", id: own.id })).isError).toBe(false);
    expect(now(h, own).status).toBe("running");

    h.missions.pause(own.id, "Gading");
    const refused = await call("kuro", { action: "resume", id: own.id });
    expect(refused).toMatchObject({ isError: true, content: `Mission ${short(own)} was paused by Gading, not by you: going on with it is theirs to say.` });
    expect(now(h, own).waitKind).toBe("paused");
    // A person ends an agent's pause too: whoever may continue it says so.
    await call("nova", { action: "pause", id: "nothing" });
    expect(h.missions.continueMission(own.id, "Gading")).toMatchObject({ mission: { status: "running" } });
    expect((await call("kuro", { action: "resume", id: own.id })).content).toBe(`Mission ${short(own)} is not paused: it is running.`);
  });

  test("the tool says what pause and resume are, and that a person's pause is theirs to end", async () => {
    const { tool } = await setup();
    expect(tool.definition.description).toContain('"pause" holds one where it is, its work kept, and "resume" goes on with one you paused yourself');
    expect(tool.definition.description).toContain("a pause a person made is theirs to end");
    expect((tool.definition.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum).toEqual(expect.arrayContaining(["pause", "resume"]));
  });
});

describe("the ways a person pauses one", () => {
  const hook = (h: Harness, args: string[], sender = "8142", chatType = "dm") =>
    missionHooks[0]!.handler({
      deps: { missions: h.missions, isAdmin: () => false },
      args,
      gatewayId: "telegram:nova",
      chatId: "8142",
      senderId: sender,
      agent: { config: { id: "nova" } },
      envelope: { chatType, senderName: sender === "8142" ? "Gading" : "A stranger" },
    } as unknown as HookContext);

  test("/mission pause in its chat, answered by the mission's own notice; /mission continue goes on; /mission lists it as paused", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    const paused = await hook(h, ["pause", short(mission)]);
    expect(paused).toEqual({ handled: true });
    expect(now(h, mission)).toMatchObject({ status: "waiting", waitKind: "paused", pausedBy: "Gading" });
    expect((await hook(h, [])).reply).toContain(`• write the report · \`${short(mission)}\` · paused`);
    expect((await hook(h, ["show", short(mission)])).reply).toContain(`Paused by Gading: /mission continue ${short(mission)} goes on from its checklist.`);
    expect((await hook(h, ["continue", short(mission)])).reply).toBe(`Mission ${short(mission)} goes on.`);
    expect(now(h, mission).status).toBe("running");
  });

  test("in a room, only the person who started it or an admin: as for a stop", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    expect((await hook(h, ["pause", short(mission)], "999", "group")).reply).toBe(`No mission ${short(mission)} here that you can act on.`);
    expect(now(h, mission).status).toBe("running");
  });

  test("the usage names it", async () => {
    const h = await missionsHarness();
    // Where the usage is said whole: a verb with no mission named. An empty list says only how one is asked for.
    expect((await hook(h, ["pause"])).reply).toContain("/mission pause <id>: stop its work for now and keep everything; /mission continue <id> goes on from its checklist, whenever you like.");
    expect((await hook(h, [])).reply).not.toContain("/mission pause");
  });

  test("the dashboard's route pauses it, says who in the answer, and words a refusal plainly", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    const audited: { action: string }[] = [];
    const control = new Hono<{ Variables: { principal: unknown } }>();
    control.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "operator", role: "operator", user: { id: "usr_operator", username: "operator", displayName: "Gading" } });
      await next();
    });
    registerMissionRoutes(control as never, { ctx: STARTERS_CTX, missions: h.missions, notes: h.notes, approvals: { pending: () => [] }, audit: { record: (row: { action: string }) => void audited.push(row) } } as never);
    const post = (verb: string) => control.request(`/missions/${mission.id}/${verb}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

    const paused = await post("pause");
    expect(paused.status).toBe(200);
    const body = (await paused.json()) as { mission: Record<string, unknown> };
    expect(body.mission).toMatchObject({ status: "waiting", waitKind: "paused", seen: "needs_you", pausedBy: "Gading" });
    // The agent's id that paused it is the daemon's own bookkeeping, not the page's.
    expect("pausedByAgent" in body.mission).toBe(false);
    expect(audited.map((row) => row.action)).toEqual(["mission_pause"]);

    const again = await post("pause");
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ plain: "This mission is already paused. Resume lets it go on." });

    const resumed = (await (await post("continue")).json()) as { mission: Record<string, unknown> };
    expect(resumed.mission).toMatchObject({ status: "running" });
    expect("pausedBy" in resumed.mission).toBe(false);
  });

  test("`nouride mission pause` asks the route and says how it stands", async () => {
    const posted: string[] = [];
    const client = { post: async (path: string) => (posted.push(path), { mission: { id: "msn_1", agentId: "nix", status: "waiting", waitKind: "paused", pausedBy: "cli" } }) } as unknown as Client;
    const printed: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line?: unknown) => void printed.push(String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "")));
    try {
      await missionCommand(client, ["pause", "msn_1"]);
    } finally {
      log.mockRestore();
    }
    expect(posted).toEqual(["/missions/msn_1/pause"]);
    expect(printed).toEqual(["✓ msn_1 · paused"]);
  });
});

describe("after a restart", () => {
  test("a paused mission is still paused, by whom it was, and nothing runs it", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.missions.pause(mission.id, "agent nova", "nova");
    const queued = h.queued.length;
    h.restart();
    h.missions.afterRestart();
    await h.settle();
    expect(now(h, mission)).toMatchObject({ status: "waiting", waitKind: "paused", pausedBy: "agent nova", pausedByAgent: "nova" });
    expect(h.queued.length).toBe(queued);
  });
});
