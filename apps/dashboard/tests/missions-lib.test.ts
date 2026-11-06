/**
 * What the Missions pages decide about a mission before drawing it (0.8.0): what a person sees it as, which of the four
 * things they can say to it apply now, how far it is against each limit, why each turn started, the list row's line,
 * what the form sends, and the "now" line read from the live feed. The pages' own tests (`mount.test.ts`, "missions")
 * render these from the engine's answers.
 */

import { describe, expect, test } from "bun:test";
import type { LiveTurn, MissionSettings, MissionView, TurnStep } from "@/commons/lib/api";
import { stepNow } from "@/commons/lib/steps";
import { actionsFor, briefShown, grouped, inFolder, meters, missionTitle, needsYouSaid, rowLine, searchedIn, seenAs, tabOf, whyStarted } from "@/modules/missions/lib/mission";
import { startInput } from "@/modules/missions/components/NewMissionForm";
import { fieldText, fits, limitsPatch, range } from "@/modules/missions/lib/limits";
import { nowSaid } from "@/modules/missions/components/NowLine";

const MISSION: MissionView = {
  id: "msn_3f2a91c0d4",
  agentId: "nova",
  startedBy: "usr_1",
  byAgent: null,
  gatewayId: "web:dashboard",
  chatId: "missions",
  goal: "Upgrade the client",
  checks: ["bun test"],
  review: null,
  reviewOn: true,
  accept: false,
  status: "running",
  waitKind: null,
  reason: null,
  report: null,
  files: [],
  lastCheck: null,
  answers: [],
  told: [],
  workdir: "/work/nova/missions/msn_3f2a91c0d4",
  branch: null,
  limits: { hours: 8, turns: 50, tokens: 50_000_000 },
  turnsUsed: 0,
  tokensUsed: 0,
  createdAt: 1,
  startedAt: 1,
  updatedAt: 1,
  endedAt: null,
  seen: "working",
  workedMs: 0,
  shown: { turns: true, tokens: "known" },
};
const waiting = (waitKind: MissionView["waitKind"], extra: Partial<MissionView> = {}): MissionView => ({ ...MISSION, status: "waiting", seen: "needs_you", waitKind, ...extra });

describe("what a person sees", () => {
  test("needs you says with what; ended says how; a queued or checking mission is working and says which", () => {
    expect(seenAs(waiting("input"))).toBe("Needs you · a question");
    expect(seenAs(waiting("approval"))).toBe("Needs you · approval");
    expect(seenAs(waiting("limit"))).toBe("Needs you · a limit");
    expect(seenAs(waiting("stuck"))).toBe("Needs you · stuck");
    expect(seenAs(waiting("accept"))).toBe("Needs you · accept");
    // A draft waits on the accept that starts it: it says so, as its notice and its buttons do (0.8.11).
    expect(seenAs(waiting("accept", { startedAt: null }))).toBe("Needs you · draft");
    expect(seenAs({ ...MISSION, status: "failed", seen: "ended" })).toBe("Ended · failed");
    expect(seenAs({ ...MISSION, status: "stopped", seen: "ended" })).toBe("Ended · stopped");
    expect(seenAs({ ...MISSION, status: "queued" })).toBe("Working · queued");
    expect(seenAs({ ...MISSION, status: "checking" })).toBe("Working · checking");
    expect(seenAs(MISSION)).toBe("Working");
    expect(seenAs({ ...MISSION, status: "done", seen: "done" })).toBe("Done");
  });

  test("its name is its goal's first sentence, cut at a word near 90 characters (0.8.0)", () => {
    expect(missionTitle("Automated Nouride test. Deliver the text to the chat, exactly once. Then call mission done.")).toBe("Automated Nouride test.");
    expect(missionTitle("Upgrade the client")).toBe("Upgrade the client");
    expect(missionTitle("  Sum up\nthe week's mail.  ")).toBe("Sum up the week's mail.");
    const long = missionTitle("Run the shell command sleep 150 and wait for it to finish then write the word ok into done.txt in your mission folder and report");
    expect(long.length).toBeLessThanOrEqual(91);
    expect(long).toEndWith("the word ok into…");
  });

  test("the list's three groups keep the daemon's order inside each", () => {
    const list = [waiting("input", { id: "a" }), { ...MISSION, id: "b" }, { ...MISSION, id: "c", status: "done" as const, seen: "done" as const }, { ...MISSION, id: "d", status: "stopped" as const, seen: "ended" as const }];
    const groups = grouped(list);
    expect([groups.needsYou, groups.working, groups.finished].map((g) => g.map((m) => m.id))).toEqual([["a"], ["b"], ["c", "d"]]);
  });

  test("a tab per group, and one per way it finished — done, failed, stopped (0.8.0); the search looks in the goal, the agent, the id and the row's line", () => {
    expect(tabOf(waiting("input"))).toBe("needs_you");
    expect(tabOf(MISSION)).toBe("working");
    expect(tabOf({ seen: "done", status: "done" })).toBe("done");
    expect(tabOf({ seen: "ended", status: "failed" })).toBe("failed");
    expect(tabOf({ seen: "ended", status: "stopped" })).toBe("stopped");
    const done = { ...MISSION, status: "done" as const, seen: "done" as const, report: "Wrote hello.txt and checked it" };
    expect(searchedIn(done)).toEqual(["Upgrade the client", "nova", "msn_3f2a91c0d4", "Wrote hello.txt and checked it"]);
    // What a chat names it by, and the question it waits on, find it too.
    expect(searchedIn(waiting("input", { reason: "Which branch should it target?" })).join(" ")).toContain("Which branch should it target?");
  });
});

describe("what a person can say to it now", () => {
  test("each verb only where the daemon would take it", () => {
    expect(actionsFor(MISSION)).toEqual(["stop"]);
    expect(actionsFor({ ...MISSION, status: "queued" })).toEqual(["stop"]);
    expect(actionsFor({ ...MISSION, status: "checking" })).toEqual(["stop"]);
    expect(actionsFor(waiting("input"))).toEqual(["answer", "acceptAsIs", "stop"]);
    expect(actionsFor(waiting("accept"))).toEqual(["accept", "continue", "stop"]);
    for (const kind of ["limit", "stuck", "unknown_outcome", "retry"] as const) expect(actionsFor(waiting(kind))).toEqual(["continue", "acceptAsIs", "stop"]);
    // Paused for its model (0.8.7): said as what it is, and that it tries again by itself.
    expect(seenAs(waiting("retry"))).toBe("Needs you · paused, retrying");
    expect(needsYouSaid(waiting("retry", { reason: "usage limit reached" }))).toBe("Its model could not answer: usage limit reached. It tries again by itself, further apart each time, for about a day. Continue tries now.");
    // Parked approvals are answered on their own cards; continuing past them is not offered — accepting it as it is is.
    expect(actionsFor(waiting("approval"))).toEqual(["acceptAsIs", "stop"]);
    // Ended, the one thing left is deleting it (0.8.13); open, there is no Delete — the daemon refuses one still open.
    for (const status of ["done", "failed", "stopped"] as const) expect(actionsFor({ ...MISSION, status })).toEqual(["delete"]);
  });
});

describe("the four meters", () => {
  test("steps settled of the checklist — a skipped one counts — and each limit as used of allowed, turns with their steps", () => {
    const plan = { steps: [{ state: "done" }, { state: "skipped" }, { state: "active" }, { state: "pending" }] };
    const [steps, turns, hours, spent] = meters({ ...MISSION, turnsUsed: 12, workedMs: 72 * 60_000, tokensUsed: 1_250_000 }, plan, 37);
    expect(steps).toMatchObject({ label: "Checklist", said: "2 of 4", share: 0.5 });
    // A turn is a whole round of work: "12 of 50" alone read as twelve actions (0.8.0).
    expect(turns).toMatchObject({ label: "Turns", said: "12 of 50 · 37 steps", near: false });
    expect(meters({ ...MISSION, turnsUsed: 1 }, plan, 1)[1]?.said).toBe("1 of 50 · 1 step");
    expect(meters({ ...MISSION, turnsUsed: 0 }, plan)[1]?.said).toBe("0 of 50");
    expect(hours).toMatchObject({ label: "Hours", said: "1h 12m of 8h", near: false });
    expect(spent).toMatchObject({ label: "Tokens", said: "1.3M of 50M", near: false });
  });

  test("an hours limit reads in hours and minutes: one raised from where a mission stood is no long float (0.8.8)", () => {
    const said = (hours: number) => meters({ ...MISSION, workedMs: 72 * 60_000, limits: { ...MISSION.limits, hours } }, null)[2]!.said;
    expect(said(8.960713333333333)).toBe("1h 12m of 8h 58m");
    expect(said(8)).toBe("1h 12m of 8h");
    expect(said(1.5)).toBe("1h 12m of 1h 30m");
    expect(said(0.25)).toBe("1h 12m of 15m");
  });

  test("a meter turns at 80% of its limit, where the daemon warns the chat — not before", () => {
    const at = (turnsUsed: number) => meters({ ...MISSION, turnsUsed }, null)[1]!.near;
    expect(at(39)).toBe(false);
    expect(at(40)).toBe(true);
    expect(meters({ ...MISSION, workedMs: 0.8 * 1.5 * 3_600_000, limits: { ...MISSION.limits, hours: 1.5 } }, null)[2]).toMatchObject({ said: "1h 12m of 1h 30m", near: true });
  });

  test("no checklist yet is said so, with no bar to fill", () => {
    expect(meters(MISSION, null)[0]).toMatchObject({ said: "no checklist yet", share: null });
  });

  test("a coding CLI's mission: its turns a count with no limit and no bar, its tokens unknown or a floor (0.8.8)", () => {
    // msn_53b16d: 1h03m in 2 turns and 215 steps, drawn "2 of 100" with a bar — a limit no CLI mission is held to.
    const cli: MissionView = { ...MISSION, turnsUsed: 2, tokensUsed: 0, shown: { turns: false, tokens: "unknown" } };
    const [, turns, , spent] = meters(cli, null, 215);
    expect(turns).toEqual({ label: "Turns", said: "2 turns · 215 steps", share: null, near: false, bar: false });
    expect(spent).toEqual({ label: "Tokens", said: "unknown of 50M (its coding CLI reports none)", share: null, near: false, bar: false });
    expect(meters({ ...cli, turnsUsed: 1 }, null)[1]?.said).toBe("1 turn");
    // Past what a model's mission would be held to, still no warning: the limit is not in force.
    expect(meters({ ...cli, turnsUsed: 99 }, null)[1]).toMatchObject({ near: false, share: null });
    // Reported for some turns only: at least that many, against the limit that holds.
    expect(meters({ ...cli, tokensUsed: 45_000_000, shown: { turns: false, tokens: "partial" } }, null)[3]).toMatchObject({ said: "at least 45M of 50M", near: true });
    // A model's mission keeps its bars.
    expect(meters(MISSION, null).filter((meter) => meter.bar === false)).toEqual([]);
  });
});

describe("why a turn started", () => {
  test("the page's own line, which the daemon writes from what woke it", () => {
    const prompt = "MISSION msn_1 — turn 3 of at most 50\nGoal: x\nWhy this turn: Gading answered your question: yes.\nChecklist: …";
    expect(whyStarted({ prompt, system: true, cause: { via: "mission" } })).toBe("Gading answered your question: yes");
    // Written for the model, with tool names in backticks; read by a person as words.
    expect(whyStarted({ prompt: "Why this turn: the mission starts. Write the checklist with `plan` first, then begin.", system: true })).toBe("the mission starts. Write the checklist with plan first, then begin");
  });

  test("a job's end, from its cause, when the page has no line", () => {
    expect(whyStarted({ prompt: "job done", system: true, cause: { via: "job completion", outcome: "finished" } })).toBe("a background job finished");
    expect(whyStarted({ prompt: "x", system: true })).toBe("Nouride started this turn");
  });
});

describe("what it needs from a person", () => {
  test("a sentence for each wait, naming the page's buttons — and a draft says whose it is", () => {
    expect(needsYouSaid(waiting("limit", { reason: "its turn limit (50 turns)" }))).toBe("It reached its turn limit (50 turns). Continue raises that limit by what Limits sets for it; Stop ends it.");
    expect(needsYouSaid(waiting("accept", { reason: "Wrote result.txt." }))).toBe("Its work is done and its checks passed. Accept the result, or Continue with what is missing.");
    expect(needsYouSaid(waiting("accept", { checks: [] }))).toBe("Its work is done. Accept the result, or Continue with what is missing.");
    expect(needsYouSaid(waiting("accept", { startedAt: null, byAgent: "nox" }))).toBe("A draft by nox: nothing runs until you Start it. Drop it removes it, with its folder.");
    expect(needsYouSaid(waiting("approval", { reason: "#apr_1 exec: rm -rf build" }))).toBe("Nothing else can move until you answer #apr_1 exec: rm -rf build.");
    expect(needsYouSaid(waiting("stuck", { reason: "three turns in a row failed" }))).toBe("It is stuck: three turns in a row failed. Continue to try again, Stop to end it.");
  });

  test("a result file inside its folder is named from there; one outside keeps its whole path", () => {
    expect(inFolder("/work/m/out/report.md", "/work/m/")).toBe("out/report.md");
    expect(inFolder("/elsewhere/report.md", "/work/m")).toBe("/elsewhere/report.md");
  });
});

describe("the list row's line", () => {
  test("the step it is on, what it waits for, its report, why it ended", () => {
    expect(rowLine({ ...MISSION, checklist: { done: 1, total: 3, active: "Write report.md" } })).toEqual({ label: "Now", text: "Write report.md" });
    expect(rowLine({ ...MISSION, checklist: null })).toEqual({ label: "Now", text: "writing its checklist" });
    expect(rowLine({ ...MISSION, status: "queued", reason: "waits for msn_1" })).toEqual({ label: "Queued", text: "waits for msn_1" });
    expect(rowLine(waiting("input", { reason: "Which branch?" }))).toEqual({ label: "Needs you", text: "It asks: Which branch?" });
    expect(rowLine({ ...MISSION, status: "done", seen: "done", report: "All green." })).toEqual({ label: "Report", text: "All green." });
    expect(rowLine({ ...MISSION, status: "stopped", seen: "ended", reason: "stopped by Gading" })).toEqual({ label: "Why", text: "stopped by Gading" });
  });
});

describe("the new mission form", () => {
  test("checks one per line with blanks dropped, the reviewer's words or none at all, and only what was set", () => {
    const base = { agent: "nova", goal: "  Upgrade the client  ", checks: "bun test\n\n  bun run lint \n", review: "  the changelog says it ", noReview: false, accept: false, workdir: " " };
    expect(startInput(base)).toEqual({ agent: "nova", goal: "Upgrade the client", checks: ["bun test", "bun run lint"], review: "the changelog says it" });
    // Skipping the reviewer wins over criteria typed before the box was ticked.
    expect(startInput({ ...base, noReview: true, accept: true, workdir: "/srv/api" })).toEqual({ agent: "nova", goal: "Upgrade the client", checks: ["bun test", "bun run lint"], noReview: true, accept: true, workdir: "/srv/api" });
    expect(startInput({ ...base, checks: "", review: "" })).toEqual({ agent: "nova", goal: "Upgrade the client" });
  });

  test("a limit is sent only inside the bounds the daemon reports", () => {
    const hours = { min: 0.25, max: 168, integer: false };
    const turns = { min: 1, max: 1000, integer: true };
    expect([fits(1.5, hours), fits(0.1, hours), fits(169, hours)]).toEqual([true, false, false]);
    expect([fits(50, turns), fits(2.5, turns), fits(0, turns), fits(Number.NaN, turns)]).toEqual([true, false, false, false]);
    expect(fits(5_000_000_000, { min: 100_000, integer: true })).toBe(true);
  });
});

describe("the limits form", () => {
  // Six agents on: the slots on the box follow them at three, and may go to six.
  const LIMITS: MissionSettings = {
    perAgent: 1,
    maxRunning: 3,
    limitHours: 12,
    limitTurns: 50,
    limitTokens: 50_000_000,
    auto: true,
    defaults: { perAgent: 1, maxRunning: 3, limitHours: 8, limitTurns: 50, limitTokens: 50_000_000 },
    bounds: {
      perAgent: { min: 1, max: 4, integer: true },
      maxRunning: { min: 1, max: 6, integer: true },
      limitHours: { min: 0.25, max: 168, integer: false },
      limitTurns: { min: 1, max: 1000, integer: true },
      limitTokens: { min: 100_000, integer: true },
    },
    editable: true,
  };

  test("a field at its default is empty, so what was changed stands out; tokens are shown in millions", () => {
    expect(["perAgent", "maxRunning", "limitHours", "limitTurns", "limitTokens"].map((key) => fieldText(LIMITS, key as never))).toEqual(["", "", "12", "", ""]);
    // The slots set by hand are set, even at the number the agents would give.
    expect(fieldText({ ...LIMITS, auto: false }, "maxRunning")).toBe("3");
    expect(fieldText({ ...LIMITS, limitTokens: 2_500_000 }, "limitTokens")).toBe("2.5");
    expect([range("maxRunning", LIMITS.bounds.maxRunning), range("limitHours", LIMITS.bounds.limitHours), range("limitTokens", LIMITS.bounds.limitTokens)]).toEqual(["1–6", "0.25–168, fractions allowed", "0.1M or more"]);
  });

  test("a save sends what was typed, tokens back from millions, and an emptied field as null — back to its default", () => {
    expect(limitsPatch(LIMITS, { maxRunning: "5", limitTokens: "2.5", limitHours: "" })).toEqual({ patch: { maxRunning: 5, limitTokens: 2_500_000, limitHours: null }, bad: [] });
    // What a field already held is no change: an empty field at its default, or the value typed back.
    expect(limitsPatch(LIMITS, { perAgent: "", limitHours: "12", limitTurns: " " })).toEqual({ patch: {}, bad: [] });
    // Back to following the agents, from a number set by hand.
    expect(limitsPatch({ ...LIMITS, auto: false, maxRunning: 4 }, { maxRunning: "" })).toEqual({ patch: { maxRunning: null }, bad: [] });
  });

  test("a value outside the bounds the daemon reports is held back, not sent", () => {
    expect(limitsPatch(LIMITS, { maxRunning: "7", limitTurns: "20" })).toEqual({ patch: { limitTurns: 20 }, bad: ["maxRunning"] });
    expect(limitsPatch(LIMITS, { limitTokens: "0.05", perAgent: "2.5", limitHours: "x" }).bad).toEqual(["limitTokens", "perAgent", "limitHours"]);
  });
});

describe("now", () => {
  const step = (seq: number, kind: TurnStep["kind"], text: string, extra: Partial<TurnStep> = {}): TurnStep => ({ seq, at: seq, kind, text, ms: 0, ...extra });
  const live = (steps: TurnStep[]): LiveTurn => ({ id: "t", agentId: "nova", chatId: "msn_1", status: "running", prompt: "", reply: "", toolCalls: 0, startedAt: 0, steps, cursor: 0 });

  test("the newest call still open — a parallel batch's last, not the first to finish", () => {
    const steps = [step(1, "tool", "exec bun test", { callId: "a" }), step(2, "tool", "read report.md", { callId: "b" }), step(3, "tool_done", "exec ok · 3s", { callId: "a" })];
    expect(stepNow(steps)).toEqual({ what: "call", text: "read report.md" });
    expect(nowSaid(MISSION, live(steps), [])).toEqual({ text: "read report.md", icon: "📖", moving: true });
    // Both still open: the one asked for last is the one said.
    expect(stepNow(steps.slice(0, 2))).toEqual({ what: "call", text: "read report.md" });
  });

  test("between calls: the model's newest thought, or thinking; a parked call is a wait", () => {
    expect(stepNow([step(1, "tool", "exec ls", { callId: "a" }), step(2, "tool_done", "exec ok", { callId: "a" })])).toEqual({ what: "thinking", text: null });
    expect(stepNow([step(1, "reasoning", "The tests need the new client first.")])).toEqual({ what: "thinking", text: "The tests need the new client first." });
    expect(stepNow([step(1, "waiting", "waiting for approval: exec")])).toEqual({ what: "waiting", text: "waiting for approval: exec" });
    expect(nowSaid(MISSION, live([]), [])).toMatchObject({ text: "Thinking…", moving: true });
  });

  test("with no turn running: its checks, the queue, a job it waits on, or the next turn", () => {
    expect(nowSaid({ ...MISSION, status: "checking" }, undefined, []).text).toBe("Running its checks");
    // Its commands passed and the reviewer looks: minutes a pass, said as what it is (0.8.10).
    expect(nowSaid({ ...MISSION, status: "checking" }, undefined, [], { pass: 2, of: 3, since: 0 })).toEqual({ text: "The reviewer is looking: pass 2 of 3", icon: "🔍", moving: true });
    expect(nowSaid({ ...MISSION, status: "queued", reason: null }, undefined, []).text).toBe("Waiting for a free slot");
    expect(nowSaid(MISSION, undefined, [{ id: "job_1", command: "bun run build", startedAt: 0 }]).text).toBe("Waiting on bun run build");
    expect(nowSaid(MISSION, undefined, []).text).toBe("Between turns. The next starts shortly");
  });
});

describe("the Brief card (0.8.11)", () => {
  test("its own folder's BRIEF.md, or the file its goal names — opened by its file's name", () => {
    expect(briefShown("/w/private/nova/missions/msn_1/BRIEF.md", "msn_1")).toEqual({ name: "BRIEF.md", said: "Kept in its folder: each turn starts from it, beside the goal." });
    expect(briefShown("/w/private/nouva/audit_rina/BRIEF.md", "msn_1")).toEqual({ name: "BRIEF.md", said: "Named in its goal: /w/private/nouva/audit_rina/BRIEF.md" });
    expect(briefShown("/w/private/nouva/brief-kk.md", "msn_1").name).toBe("brief-kk.md");
    expect(briefShown(null, "msn_1").name).toBe("BRIEF.md");
  });
});
