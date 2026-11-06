/**
 * Every state a mission can be in, against everything a person can say to it (0.8.7) — accept, accept done outside,
 * continue, answer, stop — and the buttons that say the same. On the live box a mission stuck on a check it could never
 * pass waited on a question; `/mission accept` answered "not waiting for an accept", the command typed into the answer box
 * reached the agent as words, and it went round until it gave itself up as failed with its work merged. Each state is
 * reached the way the daemon reaches it — a turn's claim, parked approvals, failed turns, a restart, a limit — not set by
 * hand, so a path that stops leading there fails here.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ButtonPress } from "@nouride/shared";
import { missionHooks } from "@/modules/hooks/builtins/mission.ts";
import type { HookContext } from "@/modules/hooks/types.ts";
import { ActionPresses, buttonsFor } from "@/modules/missions/actions.ts";
import { OptionPresses } from "@/modules/missions/options.ts";
import { FOLLOW_UP_MS } from "@/modules/missions/limits.ts";
import type { Mission } from "@/modules/missions/types.ts";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { missionsHarness } from "./harness.ts";

type Harness = Awaited<ReturnType<typeof missionsHarness>>;

const STATES = ["queued", "running", "checking", "input", "approval", "stuck", "retry", "limit", "unknown_outcome", "accept", "proposal", "done", "failed", "stopped"] as const;
type State = (typeof STATES)[number];

const CHECKS = ["test -s out.md"];
/** A question offering two answers to pick from, a button each (`options.ts`). */
const ASK = { kind: "ask" as const, question: "Which way?", options: ["keep the old route", "drop it"] };

/** A mission in `state`, reached the way the daemon reaches it, in a harness of its own. */
async function inState(state: State): Promise<{ h: Harness; mission: Mission }> {
  const h = await missionsHarness(state === "limit" ? { settings: { limitTurns: 1 } } : {});
  const started = async () => await h.start("ship the report", { checks: CHECKS });
  switch (state) {
    case "queued": {
      await started();
      const queued = await h.start("the second", { checks: CHECKS });
      return { h, mission: queued };
    }
    case "running":
      return { h, mission: await started() };
    case "checking": {
      const mission = await started();
      // A check that never comes back: the mission stays `checking` for as long as the test looks.
      h.setChecks(() => new Promise(() => {}));
      h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "wrote out.md", files: [] }));
      await h.settle();
      return { h, mission };
    }
    case "input": {
      const mission = await started();
      h.turn(mission, {}, () => h.missions.claim(mission.id, ASK));
      return { h, mission };
    }
    case "approval": {
      const mission = await started();
      h.parked.set(mission.id, [{ id: "apr_1", what: "exec: rm -rf build" }]);
      h.turn(mission);
      return { h, mission };
    }
    case "stuck": {
      const mission = await started();
      for (let i = 0; i < 3; i += 1) h.turn(mission, { worked: 0, toolCalls: 0 });
      return { h, mission };
    }
    case "retry": {
      const mission = await started();
      h.turn(mission, { failed: true, worked: 0, error: "usage limit reached" });
      return { h, mission };
    }
    case "limit": {
      const mission = await started();
      h.turn(mission);
      return { h, mission };
    }
    case "unknown_outcome": {
      const mission = await started();
      h.missions.afterRestart(new Map([[mission.id, [{ name: "send_message", arguments: { to: "telegram:nova:8142", text: "hi" } }]]]));
      return { h, mission };
    }
    case "accept": {
      const mission = await h.start("ship the report", { checks: CHECKS, accept: true });
      h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "wrote out.md", files: [] }));
      await h.settle();
      return { h, mission };
    }
    case "proposal": {
      const result = h.missions.start({ agentId: "nova", goal: "tidy the logs", checks: CHECKS, startedBy: "8142", gatewayId: "telegram:nova", chatId: "8142", byAgent: "nova", proposed: true });
      if ("refused" in result) throw new Error(result.refused);
      return { h, mission: result.mission };
    }
    case "done": {
      const mission = await started();
      h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "wrote out.md", files: [] }));
      await h.settle();
      return { h, mission };
    }
    case "failed": {
      const mission = await started();
      h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "fail", reason: "cannot", report: "" }));
      return { h, mission };
    }
    case "stopped": {
      const mission = await started();
      h.missions.stop(mission.id, "Gading");
      return { h, mission };
    }
  }
}

/** Where each state stands once reached — so a builder that drifted is caught before the matrix reads it. */
const REACHED: Record<State, { status: Mission["status"]; waitKind: Mission["waitKind"] }> = {
  queued: { status: "queued", waitKind: null },
  running: { status: "running", waitKind: null },
  checking: { status: "checking", waitKind: null },
  input: { status: "waiting", waitKind: "input" },
  approval: { status: "waiting", waitKind: "approval" },
  stuck: { status: "waiting", waitKind: "stuck" },
  retry: { status: "waiting", waitKind: "retry" },
  limit: { status: "waiting", waitKind: "limit" },
  unknown_outcome: { status: "waiting", waitKind: "unknown_outcome" },
  accept: { status: "waiting", waitKind: "accept" },
  proposal: { status: "waiting", waitKind: "accept" },
  done: { status: "done", waitKind: null },
  failed: { status: "failed", waitKind: null },
  stopped: { status: "stopped", waitKind: null },
};

describe("each state is reached the way the daemon reaches it", () => {
  for (const state of STATES) {
    test(state, async () => {
      const { h, mission } = await inState(state);
      expect(h.store.get(mission.id)).toMatchObject(REACHED[state]);
    });
  }
});

type Verb = "accept" | "outside" | "continue" | "answer" | "stop";
const VERBS: readonly Verb[] = ["accept", "outside", "continue", "answer", "stop"];

function act(h: Harness, mission: Mission, verb: Verb) {
  const as = { gatewayId: "telegram:nova", senderId: "8142" };
  switch (verb) {
    case "accept":
      return h.missions.accept(mission.id, "Gading", as);
    case "outside":
      return h.missions.acceptOutside(mission.id, "merged by hand", "Gading");
    case "continue":
      return h.missions.continueMission(mission.id, "Gading", undefined, as);
    case "answer":
      return h.missions.answer(mission.id, "B", "Gading");
    case "stop":
      return h.missions.stop(mission.id, "Gading");
  }
}

/**
 * What each verb leads to from each state: a status it ends in, or a refusal and the words it must hold — a refusal
 * that does not say what to do instead is how the person ended up typing the command into the answer box.
 */
type Outcome = { status: Mission["status"] | "started" } | { refused: RegExp };
const ENDED = { refused: /has already ended|is (done|failed|stopped), not waiting|no question waiting/ };
const NO_QUESTION = { refused: /has no question waiting/ };
const NOT_WAITING = { refused: /not waiting for you/ };

const MATRIX: Record<State, Record<Verb, Outcome>> = {
  queued: { accept: { refused: /has not started yet.*\/mission stop/ }, outside: { status: "done" }, continue: NOT_WAITING, answer: NO_QUESTION, stop: { status: "stopped" } },
  running: { accept: { refused: /still working.*--outside.*\/mission stop/ }, outside: { status: "done" }, continue: NOT_WAITING, answer: NO_QUESTION, stop: { status: "stopped" } },
  checking: { accept: { refused: /checks are running now/ }, outside: { status: "done" }, continue: NOT_WAITING, answer: NO_QUESTION, stop: { status: "stopped" } },
  input: { accept: { status: "done" }, outside: { status: "done" }, continue: { refused: /asked a question\. Answer it/ }, answer: { status: "running" }, stop: { status: "stopped" } },
  approval: { accept: { status: "done" }, outside: { status: "done" }, continue: { status: "running" }, answer: NO_QUESTION, stop: { status: "stopped" } },
  stuck: { accept: { status: "done" }, outside: { status: "done" }, continue: { status: "running" }, answer: NO_QUESTION, stop: { status: "stopped" } },
  retry: { accept: { status: "done" }, outside: { status: "done" }, continue: { status: "running" }, answer: NO_QUESTION, stop: { status: "stopped" } },
  limit: { accept: { status: "done" }, outside: { status: "done" }, continue: { status: "running" }, answer: NO_QUESTION, stop: { status: "stopped" } },
  unknown_outcome: { accept: { status: "done" }, outside: { status: "done" }, continue: { status: "running" }, answer: NO_QUESTION, stop: { status: "stopped" } },
  accept: { accept: { status: "done" }, outside: { status: "done" }, continue: { status: "running" }, answer: NO_QUESTION, stop: { status: "stopped" } },
  proposal: { accept: { status: "started" }, outside: { status: "done" }, continue: { status: "started" }, answer: NO_QUESTION, stop: { status: "stopped" } },
  done: { accept: ENDED, outside: ENDED, continue: ENDED, answer: ENDED, stop: ENDED },
  failed: { accept: ENDED, outside: ENDED, continue: ENDED, answer: ENDED, stop: ENDED },
  stopped: { accept: ENDED, outside: ENDED, continue: ENDED, answer: ENDED, stop: ENDED },
};

describe("what a person says, from every state", () => {
  for (const state of STATES) {
    for (const verb of VERBS) {
      const expected = MATRIX[state][verb];
      test(`${state} × ${verb} → ${"refused" in expected ? "refused" : expected.status}`, async () => {
        const { h, mission } = await inState(state);
        const before = h.store.get(mission.id)!;
        const told = h.told.length;
        const queued = h.queued.length;
        const result = act(h, mission, verb);
        await h.settle();
        const after = h.store.get(mission.id)!;
        if ("refused" in expected) {
          expect(result).toMatchObject({ refused: expect.stringMatching(expected.refused) });
          // A refusal changes nothing: no state, no notice, no turn.
          expect({ status: after.status, waitKind: after.waitKind, reason: after.reason }).toEqual({ status: before.status, waitKind: before.waitKind, reason: before.reason });
          expect(h.told.length).toBe(told);
          expect(h.queued.length).toBe(queued);
          return;
        }
        expect("refused" in result).toBe(false);
        if (expected.status === "started") expect(["queued", "running"]).toContain(after.status);
        else expect(after.status).toBe(expected.status);
        if (expected.status === "running") expect(h.queued.length).toBeGreaterThan(queued);
        if (expected.status === "done" || expected.status === "stopped") {
          // Ended: whatever turn it had is cut off, and nothing is queued after.
          expect(h.queued.length).toBe(queued);
          expect(h.told.at(-1)!.text).toMatch(expected.status === "done" ? /^✓ Mission/ : /^✗ Mission/);
        }
      });
    }
  }
});

describe("accepted as it stands", () => {
  for (const state of ["input", "approval", "stuck", "retry", "limit", "unknown_outcome"] as const) {
    test(`from ${state}: done, by whom, never "checks passed", its report kept and sent, its turn and approvals let go`, async () => {
      const { h, mission } = await inState(state);
      h.store.save({ ...h.store.get(mission.id)!, report: "Merged 4dd2a07a" });
      h.missions.accept(mission.id, "Gading");
      await h.settle();
      const after = h.store.get(mission.id)!;
      expect(after.status).toBe("done");
      expect(after.reason).toBe("accepted by Gading as it stood, without its checks passing");
      expect(after.report).toBe("Merged 4dd2a07a");
      const notice = h.told.at(-1)!.text;
      expect(notice).toContain("done (accepted by Gading as it stood, without its checks passing).");
      // Its report as `report.md` (0.8.11), not in the notice: it had not reached the chat in this wait.
      expect(notice).not.toContain("Merged 4dd2a07a");
      expect(h.reports.at(-1)?.report).toBe("Merged 4dd2a07a");
      expect(notice).not.toContain("checks passed");
      expect(h.stopped).toContain(mission.id);
      expect(h.parked.has(mission.id)).toBe(false);
    });
  }

  test("one with no checks says only that it was accepted as it stood", async () => {
    const h = await missionsHarness();
    const mission = await h.start("look around");
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "Go on?" }));
    h.missions.accept(mission.id, "Gading");
    expect(h.store.get(mission.id)!.reason).toBe("accepted by Gading as it stood");
  });

  test("the usual accept, after its checks passed, says they passed and carries no reason", async () => {
    const { h, mission } = await inState("accept");
    h.missions.accept(mission.id, "Gading");
    await h.settle();
    expect(h.store.get(mission.id)!.reason).toBeNull();
    expect(h.told.at(-1)!.text).toContain("checks passed");
  });

  test("twice: the second is refused and nothing is said twice", async () => {
    const { h, mission } = await inState("stuck");
    h.missions.accept(mission.id, "Gading");
    await h.settle();
    const told = h.told.length;
    expect(h.missions.accept(mission.id, "Gading")).toMatchObject({ refused: expect.stringContaining("has already ended (done)") });
    expect(h.told.length).toBe(told);
  });

  test("a turn that ends after the person closed it does not bring it back", async () => {
    const h = await missionsHarness();
    const mission = await h.start("ship it", { checks: CHECKS });
    const envelope = h.queued.at(-1)!;
    const shape = h.missions.shapeFor(mission.agentId, envelope)!;
    h.missions.acceptOutside(mission.id, "merged by hand", "Gading");
    const queued = h.queued.length;
    const told = h.told.length;
    shape.ended({ toolCalls: 3, worked: 3, tokens: 100, failed: false, interrupted: false, readOutside: false });
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("done");
    expect(h.queued.length).toBe(queued);
    expect(h.told.length).toBe(told);
  });

  test("checks that come back after it was closed are not acted on", async () => {
    const h = await missionsHarness();
    let finish: (failed: boolean) => void = () => {};
    h.setChecks(() => new Promise((resolve) => (finish = (failed) => resolve(failed ? { passed: false, failed: { command: CHECKS[0]!, output: "no" } } : { passed: true, failed: null }))));
    const mission = await h.start("ship it", { checks: CHECKS });
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "r", files: [] }));
    await h.settle();
    h.missions.stop(mission.id, "Gading");
    const queued = h.queued.length;
    finish(true);
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("stopped");
    expect(h.queued.length).toBe(queued);
  });
});

describe("its checklist when it ends", () => {
  const steps = [
    { text: "Write ok.txt", state: "done" as const, note: "written" },
    { text: "Call mission done", state: "active" as const },
    { text: "Tidy up", state: "pending" as const },
  ];

  test("done by its checks: the step it was on — calling done — is done; what was never begun is not", async () => {
    const h = await missionsHarness();
    const mission = await h.start("ship it", { checks: CHECKS, review: false });
    await h.plan(mission.id, steps);
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "r", files: [] }));
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("done");
    await h.settle();
    const plan = h.notes.plan({ agentId: "nova", gatewayId: "web:mission", chatId: mission.id })!;
    expect(plan.steps.map((step) => step.state)).toEqual(["done", "done", "pending"]);
    expect(plan.steps[0]!.note).toBe("written");
  });

  test("accepted as it stood, or stopped: the step it stopped on stays where it was", async () => {
    for (const close of ["accept", "stop"] as const) {
      const { h, mission } = await inState("stuck");
      await h.plan(mission.id, steps);
      if (close === "accept") h.missions.accept(mission.id, "Gading");
      else h.missions.stop(mission.id, "Gading");
      await h.settle();
      await h.settle();
      expect(h.notes.plan({ agentId: "nova", gatewayId: "web:mission", chatId: mission.id })!.steps.map((step) => step.state)).toEqual(["done", "active", "pending"]);
    }
  });
});

describe("a command typed as an answer", () => {
  for (const text of ["/mission accept msn_x --outside \"merged\"", "/MISSION stop msn_x", "/mission"]) {
    test(`"${text}" is refused, saying how to accept, and the question still waits`, async () => {
      const { h, mission } = await inState("input");
      const queued = h.queued.length;
      const result = h.missions.answer(mission.id, text, "Gading");
      expect(result).toMatchObject({ refused: expect.stringContaining(`/mission accept ${mission.id.slice(0, 10)}`) });
      expect(h.store.get(mission.id)).toMatchObject({ status: "waiting", waitKind: "input" });
      expect(h.store.get(mission.id)!.answers.at(-1)!.answer).toBeUndefined();
      expect(h.queued.length).toBe(queued);
    });
  }

  test("an answer that only begins like one is an answer", async () => {
    const { h, mission } = await inState("input");
    expect("refused" in h.missions.answer(mission.id, "/missions page shows it, B", "Gading")).toBe(false);
    expect(h.store.get(mission.id)!.status).toBe("running");
  });
});

// ── Buttons ─────────────────────────────────────────────────────────────

function pressOf(data: string, extra: Partial<ButtonPress> = {}): ButtonPress {
  return { gatewayId: "telegram:nova", chatId: "8142", chatType: "dm", messageId: "m1", data, senderId: "8142", senderName: "Gading", ...extra };
}

function buttonsPresses(h: Harness, admins: string[] = []) {
  const isAdmin = (who: { senderId: string }) => admins.includes(who.senderId);
  return { actions: new ActionPresses({ missions: h.missions, isAdmin }), options: new OptionPresses({ missions: h.missions, isAdmin }) };
}

/** The labels of the buttons under what a mission in each state tells its chat. */
const BUTTONS: Record<State, string[] | undefined> = {
  queued: undefined,
  running: undefined,
  checking: undefined,
  input: ["A: keep the old route", "B: drop it"],
  approval: undefined,
  stuck: ["Continue", "Accept as it is", "Stop"],
  retry: ["Retry now", "Stop"],
  limit: ["Continue", "Accept as it is", "Stop"],
  unknown_outcome: ["Continue", "Stop"],
  accept: ["Accept", "Continue", "Stop"],
  proposal: ["Start it", "Drop it"],
  done: undefined,
  failed: undefined,
  stopped: undefined,
};

describe("the buttons under each state", () => {
  for (const state of STATES) {
    test(`${state}: ${BUTTONS[state]?.join(", ") ?? "none"}`, async () => {
      const { h, mission } = await inState(state);
      const buttons = buttonsFor(h.store.get(mission.id)!);
      expect(buttons?.map((button) => button.label)).toEqual(BUTTONS[state]);
      // Telegram refuses a button carrying more than 64 bytes: a whole mission id must fit.
      for (const button of buttons ?? []) expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64);
      // And the notice that asked carried them: the wait's notice, or the proposal's.
      if (buttons) expect(h.told.findLast((one) => one.mission === mission.id)!.buttons?.map((button) => button.label)).toEqual(BUTTONS[state]);
    });
  }

  test("a question without options gets none: it is answered in words", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "What should the file be called?" }));
    expect(buttonsFor(h.store.get(mission.id)!)).toBeUndefined();
  });

  test("the follow-up hours later carries the same buttons", async () => {
    const { h, mission } = await inState("stuck");
    h.tick(FOLLOW_UP_MS + 60_000);
    h.missions.tick();
    const followUp = h.told.at(-1)!;
    expect(followUp.mission).toBe(mission.id);
    expect(followUp.text).toContain("still waiting for you");
    expect(followUp.buttons?.map((button) => button.label)).toEqual(["Continue", "Accept as it is", "Stop"]);
  });

  test("the notices name the same actions in words, for a chat that draws no buttons", async () => {
    for (const state of ["input", "stuck", "limit"] as const) {
      const { h, mission } = await inState(state);
      expect(h.told.findLast((one) => one.mission === mission.id)!.text).toContain(`/mission accept ${mission.id.slice(0, 10)}`);
    }
  });
});

describe("pressing them", () => {
  const data = (mission: Mission, verb: string, kind: string) => `mission:do:${mission.id}:${verb}:${kind}`;

  test("Accept as it is on a stuck one closes it, once; pressed again it has moved on", async () => {
    const { h, mission } = await inState("stuck");
    const { actions } = buttonsPresses(h);
    const first = await actions.press(pressOf(data(mission, "accept", "stuck")));
    expect(first).toEqual({ notice: `Mission ${mission.id.slice(0, 10)} accepted.`, settled: `Mission ${mission.id.slice(0, 10)}: accepted by Gading.` });
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("done");
    const done = h.told.filter((one) => one.text.startsWith("✓")).length;
    const second = await actions.press(pressOf(data(mission, "accept", "stuck")));
    expect(second.notice).toContain("has moved on (done)");
    expect(h.told.filter((one) => one.text.startsWith("✓")).length).toBe(done);
  });

  test("Continue on a limit raises the limit it reached", async () => {
    const { h, mission } = await inState("limit");
    const before = h.store.get(mission.id)!.limits.turns;
    const pressed = await buttonsPresses(h).actions.press(pressOf(data(mission, "continue", "limit")));
    expect(pressed.notice).toContain("told to go on");
    const after = h.store.get(mission.id)!;
    expect(after.status).toBe("running");
    expect(after.limits.turns).toBeGreaterThan(before);
  });

  test("Continue on a result waiting for its accept sends it back, told to check the work again; typed, it says what is missing", async () => {
    // From the chat's button, with nothing said: "said to go on." told the agent nothing to do (0.8.10).
    const { h, mission } = await inState("accept");
    const pressed = await buttonsPresses(h).actions.press(pressOf(data(mission, "continue", "accept")));
    expect(pressed.notice).toContain("told to go on");
    expect(h.store.get(mission.id)!.status).toBe("running");
    expect(h.queued.at(-1)!.text).toContain("sent its result back without saying what is missing. Check the work against the goal again, then call `mission` done.");
    const typed = await inState("accept");
    typed.h.missions.continueMission(typed.mission.id, "Gading", "the totals are missing");
    expect(typed.h.queued.at(-1)!.text).toContain("Gading said to go on: the totals are missing");
  });

  test("Stop on an unknown outcome stops it", async () => {
    const { h, mission } = await inState("unknown_outcome");
    await buttonsPresses(h).actions.press(pressOf(data(mission, "stop", "unknown_outcome")));
    expect(h.store.get(mission.id)!.status).toBe("stopped");
  });

  test("a proposal's Start starts it, and its Drop stops it", async () => {
    const started = await inState("proposal");
    expect((await buttonsPresses(started.h).actions.press(pressOf(data(started.mission, "accept", "accept")))).notice).toContain("started");
    expect(["queued", "running"]).toContain(started.h.store.get(started.mission.id)!.status);
    const dropped = await inState("proposal");
    await buttonsPresses(dropped.h).actions.press(pressOf(data(dropped.mission, "stop", "accept")));
    expect(dropped.h.store.get(dropped.mission.id)!.status).toBe("stopped");
  });

  test("a button for a wait it has left does nothing — continued meanwhile from elsewhere", async () => {
    const { h, mission } = await inState("stuck");
    h.missions.continueMission(mission.id, "Gading");
    const pressed = await buttonsPresses(h).actions.press(pressOf(data(mission, "accept", "stuck")));
    expect(pressed.notice).toContain("has moved on (running)");
    expect(pressed.settled).toContain("moved on before this was answered");
    expect(h.store.get(mission.id)!.status).toBe("running");
  });

  test("a button for a wait it has left does nothing — waiting on something else now", async () => {
    const { h, mission } = await inState("stuck");
    h.missions.continueMission(mission.id, "Gading");
    h.turn(mission, {}, () => h.missions.claim(mission.id, ASK));
    const pressed = await buttonsPresses(h).actions.press(pressOf(data(mission, "accept", "stuck")));
    expect(pressed.notice).toContain("waiting for input");
    expect(h.store.get(mission.id)).toMatchObject({ status: "waiting", waitKind: "input" });
  });

  test("from another chat: refused, nothing changes", async () => {
    const { h, mission } = await inState("stuck");
    const pressed = await buttonsPresses(h).actions.press(pressOf(data(mission, "accept", "stuck"), { chatId: "other" }));
    expect(pressed).toEqual({ notice: "That mission does not report to this chat." });
    expect(h.store.get(mission.id)!.waitKind).toBe("stuck");
  });

  test("in a room: the person who started it or an admin, nobody else — the option buttons alike", async () => {
    const room = { chatId: "-100", chatType: "group" as const };
    const h = await missionsHarness();
    const mission = await h.start("ship it", { checks: CHECKS, chatId: "-100", startedBy: "8142" });
    for (let i = 0; i < 3; i += 1) h.turn(mission, { worked: 0, toolCalls: 0 });
    const { actions, options } = buttonsPresses(h, ["777"]);
    expect((await actions.press(pressOf(data(mission, "accept", "stuck"), { ...room, senderId: "999" }))).notice).toBe("Only the person who started this mission, or an admin, can answer it.");
    expect(h.store.get(mission.id)!.waitKind).toBe("stuck");
    h.missions.continueMission(mission.id, "Gading");
    h.turn(mission, {}, () => h.missions.claim(mission.id, ASK));
    const b = buttonsFor(h.store.get(mission.id)!)![1]!.data;
    expect((await options.press(pressOf(b, { ...room, senderId: "999" }))).notice).toBe("Only the person who started this mission, or an admin, can answer it.");
    expect((await options.press(pressOf(b, { ...room, senderId: "777" }))).notice).toBe("Answered B.");
    expect(h.store.get(mission.id)!.status).toBe("running");
  });

  test("the starter in their room may press it", async () => {
    const h = await missionsHarness();
    const mission = await h.start("ship it", { checks: CHECKS, chatId: "-100", startedBy: "8142" });
    for (let i = 0; i < 3; i += 1) h.turn(mission, { worked: 0, toolCalls: 0 });
    await buttonsPresses(h).actions.press(pressOf(data(mission, "stop", "stuck"), { chatId: "-100", chatType: "group", senderId: "8142" }));
    expect(h.store.get(mission.id)!.status).toBe("stopped");
  });

  test("an option pressed after the mission was closed from the chat: nothing happens, and its buttons go", async () => {
    const { h, mission } = await inState("input");
    const a = buttonsFor(h.store.get(mission.id)!)![0]!.data;
    h.missions.accept(mission.id, "Gading");
    await h.settle();
    const told = h.told.length;
    const pressed = await buttonsPresses(h).options.press(pressOf(a));
    expect(pressed).toEqual({ notice: `Mission ${mission.id.slice(0, 10)} has moved on (done), so this question no longer waits.`, settled: `❓ Mission ${mission.id.slice(0, 10)}: moved on before this was answered (done).` });
    expect(h.store.get(mission.id)!.status).toBe("done");
    expect(h.told.length).toBe(told);
  });

  test("an option pressed after the mission went on to wait for something else does not answer that", async () => {
    const { h, mission } = await inState("input");
    const a = buttonsFor(h.store.get(mission.id)!)![0]!.data;
    h.missions.continueMission(mission.id, "Gading");
    expect(h.store.get(mission.id)!.waitKind).toBe("input");
    // Stuck while its question still has no answer: a restart's cut, say — the question's buttons no longer apply.
    h.missions.wait(h.store.get(mission.id)!, "stuck", "a loop");
    const pressed = await buttonsPresses(h).options.press(pressOf(a));
    expect(pressed.settled).toContain("moved on before this was answered (waiting for stuck)");
    expect(h.store.get(mission.id)!.waitKind).toBe("stuck");
  });

  test("a mission no longer on record, or data that is not a mission button's, is answered as such", async () => {
    const { h, mission } = await inState("stuck");
    const { actions } = buttonsPresses(h);
    expect(actions.owns("mission:do:x")).toBe(true);
    expect(actions.owns("mission:answer:x")).toBe(false);
    for (const bad of ["mission:do:msn_nope:accept:stuck", `mission:do:${mission.id}:delete:stuck`, `mission:do:${mission.id}:accept`, "mission:do:"]) {
      expect((await actions.press(pressOf(bad))).notice).toBe("That mission is no longer on record.");
    }
    expect(h.store.get(mission.id)!.waitKind).toBe("stuck");
  });
});

// ── The same, from a chat and the dashboard ──────────────────────────────

async function typed(h: Harness, text: string, extra: { chatId?: string; chatType?: string; senderId?: string } = {}): Promise<string | undefined> {
  const ctx = {
    deps: { missions: h.missions, isAdmin: () => false },
    args: text.split(/\s+/).slice(1),
    gatewayId: "telegram:nova",
    chatId: extra.chatId ?? "8142",
    senderId: extra.senderId ?? "8142",
    agent: { config: { id: "nova" } },
    envelope: { chatType: extra.chatType ?? "dm", senderName: "Gading" },
  } as unknown as HookContext;
  return (await missionHooks[0]!.handler(ctx)).reply;
}

describe("from a chat", () => {
  test("/mission accept <id> on one waiting on its question closes it — the live box's case", async () => {
    const { h, mission } = await inState("input");
    expect(await typed(h, `/mission accept ${mission.id.slice(0, 10)}`)).toBeUndefined();
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("done");
    expect(h.told.at(-1)!.text).toContain("accepted by Gading as it stood");
  });

  test("/mission accept <id> on one still at work says what it is doing and what can be said instead", async () => {
    const { h, mission } = await inState("running");
    const reply = await typed(h, `/mission accept ${mission.id.slice(0, 10)}`);
    expect(reply).toContain("still working");
    expect(reply).toContain(`/mission accept ${mission.id.slice(0, 10)} --outside`);
    expect(h.store.get(mission.id)!.status).toBe("running");
  });

  test("/mission answer <id> /mission accept … is refused with the right command", async () => {
    const { h, mission } = await inState("input");
    const reply = await typed(h, `/mission answer ${mission.id.slice(0, 10)} /mission accept ${mission.id.slice(0, 10)} --outside "merged"`);
    expect(reply).toContain("That is a command, not an answer");
    expect(h.store.get(mission.id)!.waitKind).toBe("input");
  });

  test("in a room, someone who did not start it cannot accept it", async () => {
    const h = await missionsHarness();
    const mission = await h.start("ship it", { checks: CHECKS, chatId: "-100", startedBy: "8142" });
    for (let i = 0; i < 3; i += 1) h.turn(mission, { worked: 0, toolCalls: 0 });
    const reply = await typed(h, `/mission accept ${mission.id.slice(0, 10)}`, { chatId: "-100", chatType: "group", senderId: "999" });
    expect(reply).toContain("that you can act on");
    expect(h.store.get(mission.id)!.waitKind).toBe("stuck");
  });

  test("an id too short to name one mission, or naming none, is not acted on", async () => {
    const { h, mission } = await inState("stuck");
    expect(await typed(h, "/mission accept msn_")).toContain("that you can act on");
    expect(await typed(h, "/mission accept msn_zzzzzz")).toContain("that you can act on");
    expect(h.store.get(mission.id)!.waitKind).toBe("stuck");
  });
});

describe("from the dashboard's API", () => {
  async function routes(h: Harness) {
    const control = new Hono<{ Variables: { principal: unknown } }>();
    control.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "operator", role: "operator", user: { id: "usr_op", username: "op", displayName: "Op" } });
      await next();
    });
    registerMissionRoutes(control as never, { missions: h.missions, notes: h.notes, approvals: { pending: () => [] }, audit: { record: () => {} } } as never);
    return (mission: Mission, verb: string, body: unknown = {}) => control.request(`/missions/${mission.id}/${verb}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  test("Accept as it is on one waiting on its question: 200, done", async () => {
    const { h, mission } = await inState("input");
    expect((await (await routes(h))(mission, "accept")).status).toBe(200);
    expect(h.store.get(mission.id)!.reason).toBe("accepted by Op as it stood, without its checks passing");
  });

  test("on one still at work: 409, with what to do instead", async () => {
    const { h, mission } = await inState("running");
    const response = await (await routes(h))(mission, "accept");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("still working");
  });

  test("a command typed into the answer box: 409, and the question still waits", async () => {
    const { h, mission } = await inState("input");
    const response = await (await routes(h))(mission, "answer", { text: `/mission accept ${mission.id} --outside "merged"` });
    expect(response.status).toBe(409);
    expect(h.store.get(mission.id)!.waitKind).toBe("input");
  });
});
