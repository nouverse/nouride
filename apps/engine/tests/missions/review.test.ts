/**
 * The reviewer (MISSIONS §5): a fresh context with only the tools that read, handed the report as a claim — and its
 * answer read strictly. Then what its verdict does to the mission.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Tool } from "@nouride/shared";
import type { Client } from "@/cli/client.ts";
import { mission as missionCommand } from "@/cli/commands/mission.ts";
import type { Review } from "@/modules/missions/checking.ts";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { REVIEW_PASSES, REVIEW_REJECTIONS } from "@/modules/missions/limits.ts";
import { reviewBrief, reviewNotes, reviewOf, verdictOf } from "@/modules/missions/review.ts";
import { readOnlyToolset } from "@/modules/tools/read-only.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { missionsHarness } from "./harness.ts";

describe("the reviewer's answer", () => {
  test("PASS on its first line passes, however it is dressed; FAIL is followed by its findings; anything else fails", () => {
    expect(verdictOf("PASS")).toEqual({ pass: true, findings: "" });
    expect(verdictOf("**PASS**\nAll 52 rows marked.")).toEqual({ pass: true, findings: "" });
    expect(verdictOf("FAIL\n- rows 41–52 are empty\n- no note on row 7")).toEqual({ pass: false, findings: "- rows 41–52 are empty\n- no note on row 7" });
    expect(verdictOf("Looks good to me overall.").pass).toBe(false);
    expect(verdictOf("Passed most of it").pass).toBe(false);
  });

  test("a hand-off cut off by its clock or rounds has judged nothing: its words are notes, not a fail (0.8.10)", () => {
    const cut = "Not a PASS. I ran out of time before finishing, so I can't confirm the mission is done.";
    expect(reviewOf({ status: "incomplete", summary: cut }, 7)).toEqual({ pass: false, findings: cut, tokens: 7, unfinished: true });
    expect(reviewOf({ status: "success", summary: "FAIL\n- §4 disagrees with C.5" }, 7)).toEqual({ pass: false, findings: "- §4 disagrees with C.5", tokens: 7 });
    expect(reviewOf({ status: "success", summary: "PASS" }, 7)).toEqual({ pass: true, findings: "", tokens: 7 });
  });

  test("an answer that names no verdict has judged nothing either, though it handed back as finished (0.8.10)", () => {
    // Both words of msn_b97876's reviewers, stopping by themselves before the deadline: each was read as a fail.
    for (const summary of ["NO VERDICT: the review ran out of time before every reference was checked.", "Not a PASS. I ran out of time before finishing, so I can't confirm the mission is done.", "Looks good to me overall."]) {
      expect(reviewOf({ status: "success", summary }, 7)).toEqual({ pass: false, findings: summary, tokens: 7, unfinished: true });
    }
    // FAIL with what fails on its own line is a verdict, as FAIL alone is.
    expect(reviewOf({ status: "success", summary: "**FAIL**: rows 41–52 are empty" }, 7)).toMatchObject({ pass: false, findings: "**FAIL**: rows 41–52 are empty" });
    expect(reviewOf({ status: "success", summary: "**FAIL**: rows 41–52 are empty" }, 7).unfinished).toBeUndefined();
  });

  test("its brief holds the report as the claim under review, and tells it to change nothing", () => {
    const brief = reviewBrief({ goal: "mark 52 rows", review: "every row marked with a reason", report: "Done, all marked.", files: ["/w/KK.xlsx"], workdir: "/w", checks: ["test -f KK.xlsx"], told: [] });
    expect(brief.context).toContain("The agent's report (the claim under review, not evidence): Done, all marked.");
    expect(brief.context).toContain("They may be weaker than the goal");
    expect(brief.constraints).toContain("change nothing");
    expect(brief.deliverable).toStartWith("First line exactly PASS or FAIL.");
    expect(brief.deliverable).toContain("If you cannot finish checking in your time, first line NO VERDICT, then what you checked and what is left");
    expect(brief.context).not.toContain("told it while it worked");
  });

  test("a pass after one that ran out of time is handed its notes, to go on from them and judge the whole", () => {
    const mission = { goal: "write Part C", review: "every path:line exists", report: "Done.", files: [], workdir: "/w", checks: [], told: [] };
    const notes = "Not a PASS. I ran out of time before finishing. C.1–C.4 hold up; C.5–C.9 unchecked.";
    expect(reviewBrief(mission, notes).context).toContain(
      `An earlier pass of this review ran out of time before it judged the work. What it checked and found is below: take what it checked as checked, go on with what it left, then judge the whole.\n${notes}`,
    );
    expect(reviewBrief(mission).context).not.toContain("An earlier pass");
    // Kept long — what it left is at the end — and never empty.
    expect(reviewNotes("x".repeat(9000))).toHaveLength(6000);
    expect(reviewNotes("  ")).toBe("it wrote nothing before its time ran out");
  });

  test("it is shown what a person told the mission while it worked, the later word the work followed (0.8.10)", () => {
    // Without it, work that followed "use the sheet's second tab" reads as work that strayed from "mark 52 rows".
    const told = [{ id: "tel_1", by: "Gading", at: 1, text: "use the second tab, not the first", read: 2 }, { id: "tel_2", by: "Gading", via: "nouva", at: 2, text: "x".repeat(800) }];
    const brief = reviewBrief({ goal: "mark 52 rows", review: null, report: "Done.", files: [], workdir: "/w", checks: [], told });
    expect(brief.context).toContain("What a person told it while it worked (their later word, which wins over the details of the goal): judge the work against the goal with these applied.");
    expect(brief.context).toContain('Gading: "use the second tab, not the first"');
    // Who passed it on is named, and a long one is whole (0.8.11): cut to 500 characters, an instruction was judged by its
    // first part.
    expect(brief.context).toContain(`Gading via nouva: "${"x".repeat(800)}"`);
  });
});

describe("only reading", () => {
  test("the reviewer's toolset offers only the tools that read, and refuses the rest without asking", () => {
    const tool = (name: string) => ({ definition: { name, description: "", parameters: {} } }) as unknown as Tool;
    const full: AgentToolset = {
      definitions: ["read", "write", "exec", "web_fetch"].map((name) => tool(name).definition),
      get: (name) => tool(name),
      requiresApproval: () => false,
      parallelSafe: () => false,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
    };
    const reading = readOnlyToolset(full);
    expect(reading.definitions.map((definition) => definition.name)).toEqual(["read", "web_fetch"]);
    expect(reading.get("write")).toBeUndefined();
    expect(reading.gate("exec", {}, {} as never)).toEqual({ action: "refuse", reason: "a review changes nothing: it only reads" });
    expect(reading.gate("read", {}, {} as never)).toEqual({ action: "run", via: "allowlist" });
  });
});

describe("what the review does", () => {
  test("a pass ends it done, and the review counts as a turn and its tokens", async () => {
    const h = await missionsHarness();
    h.setReview(async () => ({ pass: true, findings: "", tokens: 400_000 }));
    const mission = await h.start("write it", { checks: ["test -s out.txt"] });
    h.turn(mission, { tokens: 1000 }, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Wrote it.", files: [] }));
    await h.settle();
    const done = h.store.get(mission.id)!;
    expect(done.status).toBe("done");
    expect(done.tokensUsed).toBe(401_000);
    expect(done.turnsUsed).toBe(2);
    expect(h.told.at(-1)!.text).toContain("checks passed, reviewed");
  });

  test("a fail is the next turn with its findings; the same finding three times and a person decides", async () => {
    const h = await missionsHarness();
    h.setReview(async () => ({ pass: false, findings: "rows 41–52 are empty", tokens: 10 }));
    const mission = await h.start("mark the rows", { checks: ["test -f KK.xlsx"] });
    for (let i = 0; i < 2; i += 1) {
      h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "All marked.", files: [] }));
      await h.settle();
      expect(h.store.get(mission.id)!.status).toBe("running");
    }
    expect(h.store.get(mission.id)!.lastCheck).toBe("Reviewer: rows 41–52 are empty");
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "All marked.", files: [] }));
    await h.settle();
    expect(h.store.get(mission.id)!.waitKind).toBe("stuck");
  });

  test("one that runs out of its clock is no fail: the next pass goes on from its notes, and its verdict decides (0.8.10)", async () => {
    // msn_b97876 on the live box: "Not a PASS. I ran out of time before finishing" read as a failed check, four rounds
    // of the agent fixing what nobody had judged, and 28M tokens.
    const h = await missionsHarness();
    const earlier: (string | undefined)[] = [];
    const notes = "Not a PASS. I ran out of time before finishing. C.1–C.4 hold up; C.5–C.9 unchecked.";
    h.setReview(async (_mission, notesBefore) => {
      earlier.push(notesBefore);
      return earlier.length === 1 ? { pass: false, findings: notes, tokens: 100, unfinished: true } : { pass: true, findings: "", tokens: 100 };
    });
    const mission = await h.start("write Part C", { checks: ["test -s rfc.md"] });
    h.turn(mission, { tokens: 1000 }, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Written.", files: [] }));
    await h.settle();
    const done = h.store.get(mission.id)!;
    expect(done.status).toBe("done");
    expect(earlier).toEqual([undefined, notes]);
    // Never handed back as a failed check, and both passes counted.
    expect(done.lastCheck).toBeNull();
    expect(done.turnsUsed).toBe(3);
    expect(done.tokensUsed).toBe(1200);
  });

  test("out of its clock on every pass: a person decides, with what it checked — no turn sent to fix what was not judged", async () => {
    const h = await missionsHarness();
    let passes = 0;
    h.setReview(async () => ((passes += 1), { pass: false, findings: `pass ${passes}: checked half, the rest unchecked`, tokens: 10, unfinished: true }));
    const mission = await h.start("write Part C", { checks: ["test -s rfc.md"] });
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Written.", files: [] }));
    await h.settle();
    const waiting = h.store.get(mission.id)!;
    expect(passes).toBe(REVIEW_PASSES);
    expect(waiting.status).toBe("waiting");
    expect(waiting.waitKind).toBe("accept");
    expect(waiting.reason).toStartWith(`The reviewer ran out of time ${REVIEW_PASSES} times before it judged the work. What it checked and found:\npass 3: checked half, the rest unchecked`);
    expect(waiting.lastCheck).toBeNull();
  });

  test("out of its clock at the mission's limit: the limit's wait, the reviewer's notes on its page", async () => {
    const h = await missionsHarness({ settings: { limitTokens: 1_100 } });
    let passes = 0;
    h.setReview(async () => ((passes += 1), { pass: false, findings: "checked half", tokens: 200, unfinished: true }));
    const mission = await h.start("write Part C", { checks: ["test -s rfc.md"] });
    h.turn(mission, { tokens: 1000 }, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Written.", files: [] }));
    await h.settle();
    const waiting = h.store.get(mission.id)!;
    expect(passes).toBe(1);
    expect(waiting.waitKind).toBe("limit");
    expect(waiting.lastCheck).toBe("Reviewer, out of time before it judged the work: checked half");
  });

  test("while it looks, the mission says which pass and since when — its page and `mission show` — and nothing once done", async () => {
    // The page said "Running its checks" through ten minutes of a review, and the owner took the mission for stuck.
    const h = await missionsHarness();
    let finish: (review: Review) => void = () => {};
    h.setReview(() => new Promise<Review>((resolve) => (finish = resolve)));
    const mission = await h.start("write Part C", { checks: ["test -s rfc.md"] });
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Written.", files: [] }));
    await h.settle();
    const reviewing = { pass: 1, of: REVIEW_PASSES, since: h.now() };
    expect(h.missions.reviewing(mission.id)).toEqual(reviewing);
    const control = new Hono();
    registerMissionRoutes(control as never, { missions: h.missions, notes: h.notes, approvals: { pending: () => [] } } as never);
    const detail = (await (await control.request(`/missions/${mission.id}`)).json()) as { reviewing?: unknown };
    expect(detail.reviewing).toEqual(reviewing);
    finish({ pass: true, findings: "", tokens: 0 });
    await h.settle();
    expect(h.missions.reviewing(mission.id)).toBeNull();
    expect(((await (await control.request(`/missions/${mission.id}`)).json()) as { reviewing?: unknown }).reviewing).toBeUndefined();
    expect(h.store.get(mission.id)!.status).toBe("done");
  });

  test("`nouride mission show` says the reviewer is looking, which pass and for how long", async () => {
    const view = { id: "msn_1", agentId: "nix", status: "checking", waitKind: null, goal: "write Part C", checks: ["test -s rfc.md"], turnsUsed: 7, limits: { turns: 100, tokens: 100_000_000, hours: 8 }, workedMs: 60_000, tokensUsed: 1000, reason: null, report: null, files: [], workdir: "/w" };
    const client = { get: async () => ({ mission: view, plan: null, parked: [], reviewing: { pass: 2, of: 3, since: Date.now() - 4 * 60_000 } }) } as unknown as Client;
    const said: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line?: unknown) => void said.push(String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "")));
    try {
      await missionCommand(client, ["show", "msn_1"]);
    } finally {
      log.mockRestore();
    }
    expect(said.join("\n")).toContain("● The reviewer is looking: pass 2 of 3, 4m so far");
  });

  test("failed by the reviewer three times in a row, each time for something new: a person decides — the cycle is the loop", async () => {
    // A finding new each time never fails "the same way": done, rejected, done went on to the mission's limits.
    const h = await missionsHarness();
    let round = 0;
    h.setReview(async () => ((round += 1), { pass: false, findings: `round ${round}: one more reference is off`, tokens: 10 }));
    const mission = await h.start("write Part C", { checks: ["test -s rfc.md"] });
    for (let i = 0; i < REVIEW_REJECTIONS - 1; i += 1) {
      h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Fixed.", files: [] }));
      await h.settle();
      expect(h.store.get(mission.id)!.status).toBe("running");
    }
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Fixed.", files: [] }));
    await h.settle();
    const stuck = h.store.get(mission.id)!;
    expect(stuck.waitKind).toBe("stuck");
    expect(stuck.reason).toBe(`the reviewer failed it ${REVIEW_REJECTIONS} times in a row, each time for what it found then. Its last finding is on the page`);
    expect(stuck.lastCheck).toBe(`Reviewer: round ${REVIEW_REJECTIONS}: one more reference is off`);
  });

  test("a pass between the reviewer's fails starts the count again", async () => {
    // A pass that goes one more turn — words told while it was checked, unread — and is failed after: one fail, not three.
    const h = await missionsHarness({ steerTurn: () => ({ taken: false, why: "none" }) });
    const verdicts: (boolean | "hold")[] = [false, false, "hold", false];
    let release: (review: Review) => void = () => {};
    h.setReview(() => {
      const next = verdicts.shift();
      return next === "hold" ? new Promise<Review>((resolve) => (release = resolve)) : Promise.resolve({ pass: next ?? false, findings: `finding ${verdicts.length}`, tokens: 10 });
    });
    const mission = await h.start("write Part C", { checks: ["test -s rfc.md"] });
    const done = () => h.turn(h.store.get(mission.id)!, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Fixed.", files: [] }));
    for (let i = 0; i < 2; i += 1) {
      done();
      await h.settle();
    }
    done();
    await h.settle();
    h.missions.tell(mission.id, "also the summary", "Gading");
    release({ pass: true, findings: "", tokens: 10 });
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("running");
    done();
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("running");
    expect(h.store.get(mission.id)!.waitKind).toBeNull();
  });

  test("never over a failed command: the reviewer runs only once the commands pass", async () => {
    const h = await missionsHarness();
    let reviewed = 0;
    h.setReview(async () => ((reviewed += 1), { pass: true, findings: "", tokens: 0 }));
    h.setChecks(async () => ({ passed: false, failed: { command: "bun test", output: "1 fail" } }));
    const mission = await h.start("fix it", { checks: ["bun test"] });
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Fixed.", files: [] }));
    await h.settle();
    expect(reviewed).toBe(0);
    expect(h.store.get(mission.id)!.status).toBe("running");
  });

  test("a reviewer that could not run is no pass: a person accepts instead", async () => {
    const h = await missionsHarness();
    h.setReview(async () => {
      throw new Error("the model is down");
    });
    const mission = await h.start("write it", { checks: ["test -s out.txt"] });
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Wrote it.", files: [] }));
    await h.settle();
    expect(h.store.get(mission.id)!.waitKind).toBe("accept");
  });

  test("a round whose checks pass clears the last round's failure, and a reviewer that cannot run after a pass ran out of time hands on its notes", async () => {
    // msn_b97876: the page showed the last round's "Reviewer: Not a PASS…" as its failed check while the next round's
    // reviewer could not run — the person read a verdict on work nobody had judged.
    const h = await missionsHarness();
    const reviews: (() => Promise<Review>)[] = [
      async () => ({ pass: false, findings: "C.4 is off by a line", tokens: 10 }),
      async () => ({ pass: false, findings: "checked C.1–C.4; C.5–C.9 left", tokens: 10, unfinished: true }),
      async () => {
        throw new Error("My connection to the model dropped part-way through my reply.");
      },
    ];
    h.setReview(() => reviews.shift()!());
    const mission = await h.start("write Part C", { checks: ["test -s rfc.md"] });
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Written.", files: [] }));
    await h.settle();
    expect(h.store.get(mission.id)!.lastCheck).toBe("Reviewer: C.4 is off by a line");
    h.turn(h.store.get(mission.id)!, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Fixed C.4.", files: [] }));
    await h.settle();
    const waiting = h.store.get(mission.id)!;
    expect(waiting.waitKind).toBe("accept");
    expect(waiting.lastCheck).toBeNull();
    // The report is not in the wait: it goes whole as `report.md` with the notice (0.8.11).
    expect(waiting.reason).toBe("(The reviewer could not run, so this waits for you.)\nWhat an earlier pass checked before its time ran out:\nchecked C.1–C.4; C.5–C.9 left");
  });

  test("off, it is not asked", async () => {
    const h = await missionsHarness();
    let reviewed = 0;
    h.setReview(async () => ((reviewed += 1), { pass: false, findings: "no", tokens: 0 }));
    const mission = await h.start("fetch and post", { checks: ["true"], review: false });
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Posted.", files: [] }));
    await h.settle();
    expect(reviewed).toBe(0);
    expect(h.store.get(mission.id)!.status).toBe("done");
  });
});
