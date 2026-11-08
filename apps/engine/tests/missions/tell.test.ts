/**
 * `tell` (0.8.10): a person's words for a mission while it works — recorded first, put into the
 * turn at work or kept for the next, on every later page, and never a resume, a new goal or a raised limit. A mission
 * could be stopped, answered, let go on and accepted, and told nothing: msn_3d28e0 worked 3h41m in three turns.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Client } from "@/cli/client.ts";
import { mission as missionCommand } from "@/cli/commands/mission.ts";
import { missionHooks } from "@/modules/hooks/builtins/mission.ts";
import type { HookContext } from "@/modules/hooks/types.ts";
import type { SteerOutcome } from "@/modules/missions/tell.ts";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import type { Mission, Told } from "@/modules/missions/types.ts";
import { missionsHarness } from "./harness.ts";

const done = { kind: "done" as const, summary: "Done.", report: "Report written.", files: [] };

describe("telling a mission something while it works", () => {
  test("into the turn at work, recorded before it is handed over, and said as where it went", async () => {
    const handed: { mission: string; told: Told; saved: boolean }[] = [];
    let reach: SteerOutcome = { taken: true, when: "next_step" };
    const h = await missionsHarness({
      // What the pipeline does with it — and whether it was already on the record when it was handed over.
      steerTurn: (mission, told) => (handed.push({ mission: mission.id, told, saved: h.store.get(mission.id)!.told.some((one) => one.id === told.id) }), reach),
    });
    const mission = await h.start();
    const said = h.missions.tell(mission.id, "  use the second tab, not the first  ", "Gading");
    expect(said).toMatchObject({ said: "Told. It reads this before its next step." });
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ mission: mission.id, saved: true, told: { by: "Gading", text: "use the second tab, not the first" } });
    expect(handed[0]!.told.read).toBeUndefined();
    // Nothing else about it moved: not a resume, not a limit, not its goal.
    const now = h.store.get(mission.id)!;
    expect(now).toMatchObject({ status: "running", goal: mission.goal, limits: mission.limits, turnsUsed: mission.turnsUsed });
    expect(now.told.map((one) => one.text)).toEqual(["use the second tab, not the first"]);

    // A coding CLI's turn: into its prompt; one whose CLI takes nothing mid-prompt, after it.
    reach = { taken: true, when: "into_cli" };
    expect(h.missions.tell(mission.id, "and keep the tests", "Gading")).toMatchObject({ said: expect.stringContaining("Its coding CLI is given this in the turn it is working on") });
    reach = { taken: true, when: "after_prompt" };
    expect(h.missions.tell(mission.id, "one more", "Gading")).toMatchObject({ said: "Told. Its coding CLI reads this once the prompt it is working on ends." });
    // A turn that has read all it reads keeps it for the next.
    reach = { taken: false, why: "full" };
    expect(h.missions.tell(mission.id, "past the cap", "Gading")).toMatchObject({ said: expect.stringContaining("Kept for its next turn: the turn at work has read all it reads") });
  });

  test("kept for the next turn when none is at work: its page says it in full, new — then read, on every page after", async () => {
    const h = await missionsHarness({ steerTurn: () => ({ taken: false, why: "none" }) });
    const mission = await h.start();
    expect(h.missions.tell(mission.id, "the client wants PDF, not DOCX", "Gading", "nouva")).toMatchObject({ said: "Kept for its next turn, which reads it first." });
    const first = h.turn(mission)!;
    expect(first.text).toContain("Told by a person while you worked: 1, 1 of them NEW. Follow what they say: their word wins over the details of the goal above. The checks still decide when it is done: if following it would fail them, or it asks for different work altogether, say so with `mission` action \"ask\".");
    expect(first.text).toContain('- NEW, 0m ago, from Gading via nouva: "the client wants PDF, not DOCX"');
    // Read in the turn whose page it was on.
    expect(h.store.get(mission.id)!.told[0]!.read).toBe(1);
    const second = h.turn(h.store.get(mission.id)!)!;
    expect(second.text).toContain('- read in turn 1, from Gading via nouva: "the client wants PDF, not DOCX"');
    expect(second.text).not.toContain("NEW");
    expect(second.text).toContain("Told by a person while you worked: 1, each read in the turn named. Keep following it: their word wins over the details of the goal above.");
  });

  test("its turn reading it marks it read in that turn, once", async () => {
    const h = await missionsHarness({ steerTurn: () => ({ taken: true, when: "next_step" }) });
    const mission = await h.start();
    h.turn(mission);
    const said = h.missions.tell(mission.id, "skip the appendix", "Gading");
    const told = "mission" in said ? said.mission.told[0]! : null;
    h.missions.toldRead(mission.id, [told!.id, "tel_not_there"]);
    expect(h.store.get(mission.id)!.told[0]!.read).toBe(2);
    h.tick(1_000);
    h.missions.toldRead(mission.id, [told!.id]);
    expect(h.store.get(mission.id)!.told[0]!.read).toBe(2);
  });

  test("a waiting mission keeps it and is not moved by it — the answer says what moves it", async () => {
    const h = await missionsHarness({ steerTurn: () => ({ taken: false, why: "none" }) });
    const asking = await h.start();
    h.turn(asking, {}, () => h.missions.claim(asking.id, { kind: "ask", question: "Which branch?" }));
    const queuedBefore = h.queued.length;
    expect(h.missions.tell(asking.id, "main is fine", "Gading")).toMatchObject({ said: expect.stringContaining(`It is waiting for your answer: /mission answer ${asking.id.slice(0, 10)}`) });
    expect(h.store.get(asking.id)!).toMatchObject({ status: "waiting", waitKind: "input" });
    expect(h.queued.length).toBe(queuedBefore);
    // Never an answer: the question is still open.
    expect(h.store.get(asking.id)!.answers.at(-1)!.answer).toBeUndefined();

    const kinds: [Mission["waitKind"], string][] = [
      ["limit", "It is waiting at its limit: /mission continue"],
      ["stuck", "It is stuck: /mission continue"],
      ["approval", "It is waiting for an approval to be answered"],
      ["unknown_outcome", "It waits for you to say whether to go on"],
      ["retry", "its model could not answer, and it tries again by itself"],
    ];
    for (const [kind, words] of kinds) {
      const one = await h.start(`work ${kind}`, { startedBy: "8142" });
      h.missions.wait(h.store.get(one.id)!, kind!, "because");
      // Where they went, as a kind beside the chat's words, for the dashboard to say in its own (0.8.23).
      expect(h.missions.tell(one.id, "note", "Gading")).toMatchObject({ said: expect.stringContaining(words), where: kind });
      expect(h.store.get(one.id)!.status).toBe("waiting");
    }
    expect(h.missions.tell(asking.id, "and the tag too", "Gading")).toMatchObject({ where: "answer" });
  });

  test("a proposal not started, and one queued behind others, read it at their first turn", async () => {
    const h = await missionsHarness({ steerTurn: () => ({ taken: false, why: "none" }), settings: { perAgent: 1, maxRunning: 1 } });
    const proposal = await h.start("tidy the logs", { startedBy: "nouride:system", byAgent: "nova", proposed: true });
    expect(h.missions.tell(proposal.id, "only the last week", "Gading")).toMatchObject({ said: expect.stringContaining("it has not started. /mission accept") });
    await h.start("first one");
    const queued = await h.start("second one");
    expect(h.store.get(queued.id)!.status).toBe("queued");
    expect(h.missions.tell(queued.id, "start with the README", "Gading")).toMatchObject({ said: "Kept: it has not started yet, and its first turn reads this." });
  });

  test("refused for a mission that is not there or has ended, words that are not there, and words past the limit", async () => {
    const h = await missionsHarness();
    expect(h.missions.tell("msn_nothere0000", "hi", "Gading")).toEqual({ refused: "No mission msn_nothere0000.", why: "missing" });
    const mission = await h.start();
    expect(h.missions.tell(mission.id, "   ", "Gading")).toMatchObject({ refused: expect.stringContaining("Tell it what?") });
    expect(h.missions.tell(mission.id, "x".repeat(4001), "Gading")).toMatchObject({ refused: expect.stringContaining("a tell is 4000 at most"), why: "long", length: 4001, max: 4000 });
    h.missions.stop(mission.id, "Gading");
    expect(h.missions.tell(mission.id, "too late", "Gading")).toMatchObject({ refused: expect.stringContaining("has already ended (stopped)") });
    expect(h.store.get(mission.id)!.told).toEqual([]);
  });

  test("the record keeps the last fifty", async () => {
    const h = await missionsHarness({ steerTurn: () => ({ taken: false, why: "none" }) });
    const mission = await h.start();
    for (let i = 1; i <= 55; i += 1) h.missions.tell(mission.id, `note ${i}`, "Gading");
    const told = h.store.get(mission.id)!.told;
    expect(told).toHaveLength(50);
    expect(told[0]!.text).toBe("note 6");
    expect(told.at(-1)!.text).toBe("note 55");
  });
});

describe("words told while its checks run (§3.4)", () => {
  async function checkingWith(h: Awaited<ReturnType<typeof missionsHarness>>, extra: Parameters<typeof h.start>[1] = {}) {
    let release: () => void = () => {};
    h.setChecks(() => new Promise((resolve) => (release = () => resolve({ passed: true, failed: null }))));
    const mission = await h.start("write the report", { checks: ["test -f report.md"], ...extra });
    h.turn(mission, {}, () => h.missions.claim(mission.id, done));
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("checking");
    return { mission, release: async () => (release(), await h.settle()) };
  }

  test("said as where it goes: a fail's next turn, or after a pass", async () => {
    const h = await missionsHarness({ steerTurn: () => ({ taken: false, why: "none" }) });
    const { mission } = await checkingWith(h);
    expect(h.missions.tell(mission.id, "also the summary", "Gading")).toMatchObject({ said: "Kept: its checks are running. If they fail, its next turn reads this; if they pass, it goes one more turn to read this before it ends." });
  });

  test("a pass that would end by itself goes one more turn to read it, and the next done is checked again", async () => {
    const h = await missionsHarness({ steerTurn: () => ({ taken: false, why: "none" }) });
    const { mission, release } = await checkingWith(h);
    h.missions.tell(mission.id, "also the summary", "Gading");
    await release();
    const now = h.store.get(mission.id)!;
    expect(now.status).toBe("running");
    expect(h.queued.at(-1)!.text).toContain("your checks passed, but while they ran a person told you something you have not read");
    // Read now; checked again, and this time it ends.
    h.setChecks(async () => ({ passed: true, failed: null }));
    const next = h.turn(now, {}, () => h.missions.claim(mission.id, done))!;
    expect(next.text).toContain('- NEW, 0m ago, from Gading: "also the summary"');
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("done");
  });

  test("a pass a person accepts anyway waits for them, the words shown beside the result", async () => {
    const h = await missionsHarness({ steerTurn: () => ({ taken: false, why: "none" }) });
    const { mission, release } = await checkingWith(h, { accept: true });
    expect(h.missions.tell(mission.id, "it should be in Indonesian", "Gading")).toMatchObject({ said: expect.stringContaining("it waits for your accept, with this shown") });
    await release();
    const now = h.store.get(mission.id)!;
    expect(now).toMatchObject({ status: "waiting", waitKind: "accept" });
    expect(now.reason).toStartWith(`Told while it was being checked, and not read yet. /mission continue ${mission.id.slice(0, 10)} has it work on this:\nGading: "it should be in Indonesian"`);
    expect(h.told.at(-1)!.text).toContain('Gading: "it should be in Indonesian"');
  });

  test("a pass with nothing unread ends as it always did", async () => {
    const h = await missionsHarness({ steerTurn: () => ({ taken: true, when: "next_step" }) });
    const { mission, release } = await checkingWith(h);
    // Told while it worked, and read in that turn: nothing holds the end.
    const told = h.missions.tell(mission.id, "fine", "Gading");
    h.missions.toldRead(mission.id, ["mission" in told ? told.mission.told[0]!.id : ""]);
    await release();
    expect(h.store.get(mission.id)!.status).toBe("done");
  });
});

describe("the ways in", () => {
  test("/mission tell in the mission's chat answers with where the words went; a stranger in a room cannot", async () => {
    const h = await missionsHarness({ steerTurn: () => ({ taken: true, when: "next_step" }) });
    const mission = await h.start();
    const typed = async (text: string, sender = "8142", chatType = "dm") =>
      (
        await missionHooks[0]!.handler({
          deps: { missions: h.missions, isAdmin: () => false },
          args: text.split(/\s+/).slice(1),
          gatewayId: "telegram:nova",
          chatId: "8142",
          senderId: sender,
          agent: { config: { id: "nova" } },
          envelope: { chatType, senderName: sender === "8142" ? "Gading" : "Rina" },
        } as unknown as HookContext)
      ).reply;
    expect(await typed(`/mission tell ${mission.id.slice(0, 10)} use the second tab`)).toBe("Told. It reads this before its next step.");
    expect(h.store.get(mission.id)!.told).toEqual([expect.objectContaining({ by: "Gading", text: "use the second tab" })]);
    expect(await typed(`/mission tell ${mission.id.slice(0, 10)}`)).toContain("Tell it what?");
    expect(await typed(`/mission tell ${mission.id.slice(0, 10)} me too`, "999", "group")).toContain("that you can act on");
    expect(await typed("/mission nonsense")).toBeUndefined();
  });

  test("the dashboard's route: an operator tells it and is answered where it went, audited; a viewer cannot", async () => {
    const h = await missionsHarness({ steerTurn: () => ({ taken: false, why: "none" }) });
    const audited: { action: string; details: unknown }[] = [];
    const app = (role: string) => {
      const control = new Hono<{ Variables: { principal: unknown } }>();
      control.use("*", async (c, next) => {
        c.set("principal", { kind: "user", actor: role, role, user: { id: `usr_${role}`, username: role, displayName: role === "operator" ? "Gading" : role } });
        await next();
      });
      registerMissionRoutes(control as never, { missions: h.missions, notes: h.notes, approvals: { pending: () => [] }, audit: { record: (row: { action: string; details: unknown }) => void audited.push(row) } } as never);
      return (path: string, body: unknown) => control.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    };
    const mission = await h.start();
    const told = await app("operator")(`/missions/${mission.id}/tell`, { text: "the totals first" });
    expect(told.status).toBe(200);
    expect(await told.json()).toMatchObject({ said: "Kept for its next turn, which reads it first.", plain: "Kept for its next turn, which reads it first.", mission: { told: [{ by: "Gading", text: "the totals first" }] } });
    expect(audited).toEqual([{ action: "mission_tell", actor: "operator", agentId: "nova", details: { mission: mission.id, chars: 16 } } as never]);
    expect((await app("viewer")(`/missions/${mission.id}/tell`, { text: "hi" })).status).toBe(403);
    const empty = await app("operator")(`/missions/${mission.id}/tell`, {});
    expect(empty.status).toBe(409);
    expect(((await empty.json()) as { error: string }).error).toContain("Tell it what?");
    // Waiting on a person, the chat's words name the command that moves it on; the page's, its button (0.8.23).
    h.missions.wait(h.store.get(mission.id)!, "limit", "because");
    const waiting = (await (await app("operator")(`/missions/${mission.id}/tell`, { text: "then the rest" })).json()) as { said: string; plain: string };
    expect(waiting.said).toContain("/mission continue");
    expect(waiting.plain).toBe("Kept for its next turn. It is waiting at its limit: Continue lets it go on.");
  });

  test("`nouride mission tell` says where the words went, `show` lists them — and a daemon before 0.8.10, which sends none, none", async () => {
    const view = { id: "msn_1", agentId: "nix", status: "running", waitKind: null, goal: "ship it", checks: [], turnsUsed: 2, limits: { turns: 10, tokens: 1_000_000, hours: 2 }, workedMs: 60_000, tokensUsed: 1000, reason: null, report: null, files: [], workdir: "/w" };
    const told: Told[] = [
      { id: "tel_1", by: "Gading", at: 1, text: "use the second tab", read: 2 },
      { id: "tel_2", by: "Rina", via: "nova", at: 2, text: "PDF, not DOCX" },
    ];
    let detail: unknown = { mission: { ...view, told }, plan: null, parked: [] };
    const posted: unknown[] = [];
    const client = {
      get: async () => detail,
      post: async (path: string, body: unknown) => (posted.push({ path, body }), { mission: { ...view, told }, said: "Told. It reads this before its next step." }),
    } as unknown as Client;
    const said: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line?: unknown) => void said.push(String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "")));
    let older = "";
    try {
      await missionCommand(client, ["tell", "msn_1", "use", "the", "second", "tab"]);
      await missionCommand(client, ["show", "msn_1"]);
      detail = { mission: view, plan: null, parked: [] };
      const before = said.length;
      await missionCommand(client, ["show", "msn_1"]);
      older = said.slice(before).join("\n");
    } finally {
      log.mockRestore();
    }
    expect(posted).toEqual([{ path: "/missions/msn_1/tell", body: { text: "use the second tab" } }]);
    const out = said.join("\n");
    expect(out).toContain("✓ msn_1 · running: Told. It reads this before its next step.");
    expect(out).toContain("Told while it worked: 2");
    expect(out).toContain("read in turn 2 · Gading: use the second tab");
    expect(out).toContain("not read yet · Rina via nova: PDF, not DOCX");
    expect(older).toContain("Goal: ship it");
    expect(older).not.toContain("Told while it worked");
  });
});

