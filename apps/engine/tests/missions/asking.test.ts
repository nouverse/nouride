/**
 * A mission's question, from the moment it is asked (`missions/asking.ts`).
 *
 * It used to be kept until the turn's end, and a coding CLI's mission is one turn of hours: a mission with work left that
 * did not depend on the answer sent its question with `send_message` instead, to a chat nobody had open, and stayed
 * "running" with nothing to say it had asked. So the question leaves at the call. As before the turn then ends and the
 * mission waits; with `keep_working` it goes on, and the answer is handed to the turn at work.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Client } from "@nouride/cli-kit";
import type { ToolContext } from "@nouride/shared";
import { mission as missionCommand } from "../../../cli/src/commands/mission.ts";
import { missionHooks } from "@/modules/hooks/builtins/mission.ts";
import type { HookContext } from "@/modules/hooks/types.ts";
import { openQuestion } from "@/modules/missions/asking.ts";
import { OptionPresses } from "@/modules/missions/options.ts";
import type { SteerOutcome } from "@/modules/missions/tell.ts";
import type { Mission, Told } from "@/modules/missions/types.ts";
import { missionQuestions } from "@/modules/pipeline/mission-questions.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { createMissionTools, keepsWorking } from "@/modules/tools/builtins/mission.ts";
import { createWorkTool } from "@/modules/tools/builtins/work.ts";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { missionsHarness, STARTERS_CTX } from "./harness.ts";

const short = (mission: Pick<Mission, "id">) => mission.id.slice(0, 10);
const QUESTION = "Mermaid adds 735 KB for one flowchart. Take it?";

/** A harness whose turn at work takes words, and what it was handed. */
async function taking(reach: SteerOutcome = { taken: true, when: "into_cli" }) {
  const handed: { told: Told; saved: boolean }[] = [];
  const h = await missionsHarness({
    steerTurn: (mission, told) => (handed.push({ told, saved: h.store.get(mission.id)!.told.some((one) => one.id === told.id) }), reach),
  });
  return { h, handed };
}

describe("a question that waits for its answer", () => {
  test("is in its chat at the call, with its options' buttons, and once: the turn's end adds nothing, and the mission waits", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    let saidAtCall = 0;
    h.turn(mission, {}, () => {
      const asked = h.missions.ask(mission.id, { question: "Keep the old sheet?", options: ["keep it", "drop it"] });
      expect(asked).toEqual({ asked: "Keep the old sheet?\n\nA) keep it\nB) drop it", meanwhile: false, reach: null });
      // In the chat already, the turn not yet ended and the mission still at work.
      saidAtCall = h.told.filter((one) => one.text.includes("Keep the old sheet?")).length;
      expect(h.store.get(mission.id)!.status).toBe("running");
      // A turn that has asked is ending: a limit read now leaves it to end (`timers.ts` `stopAtLimit`).
      expect(h.missions.claimedAt(mission.id)).not.toBeNull();
    });
    expect(saidAtCall).toBe(1);
    const notices = h.told.filter((one) => one.text.includes("Keep the old sheet?"));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toBe(
      `❓ write the report (${short(mission)}) asks: Keep the old sheet?\n\nA) keep it\nB) drop it\n\nAnswer: reply to this in your own words, or /mission answer ${short(mission)} <your answer> · or accept it as it is: /mission accept ${short(mission)}`,
    );
    expect(notices[0]!.buttons!.map((button) => button.label)).toEqual(["A: keep it", "B: drop it"]);
    const waiting = h.store.get(mission.id)!;
    expect(waiting).toMatchObject({ status: "waiting", waitKind: "input", reason: "Keep the old sheet?\n\nA) keep it\nB) drop it" });
    expect(waiting.answers.at(-1)).toMatchObject({ asked: "wait", options: ["keep it", "drop it"] });
  });

  test("answered while its turn is still ending, the answer is kept and the mission never waits for it", async () => {
    // A coding CLI takes up to half a minute to end a turn it was told ends here, and the question is already in the chat.
    const { h, handed } = await taking({ taken: false, why: "ending" });
    const mission = await h.start();
    h.turn(mission, {}, () => {
      h.missions.ask(mission.id, { question: "Keep the old sheet?" });
      expect(h.missions.answer(mission.id, "yes, rename it", "Gading")).toMatchObject({ said: "Answered. Kept for its next turn, which reads it first.", where: "next_turn" });
    });
    expect(handed).toHaveLength(1);
    const after = h.store.get(mission.id)!;
    expect(after.status).toBe("running");
    expect(after.answers.at(-1)!.answer).toBe("yes, rename it");
    // Its next turn has the answer on its page, new.
    const page = h.turn(after)!.text;
    expect(page).toContain('Asked and answered: 1. Latest: "Keep the old sheet?" → "yes, rename it"');
    expect(page).toContain('- NEW, 0m ago, from Gading: "Answer to your question "Keep the old sheet?": yes, rename it"');
  });
});

describe("a question asked with keep_working", () => {
  test("leaves the mission at work, says so in its chat, and claims nothing", async () => {
    const { h } = await taking();
    const mission = await h.start();
    h.turn(mission, {}, () => {
      expect(h.missions.ask(mission.id, { question: QUESTION, options: ["take it", "leave it out"], meanwhile: true })).toMatchObject({ meanwhile: true });
      expect(h.missions.claimedAt(mission.id)).toBeNull();
      const asking = h.store.get(mission.id)!;
      expect(asking).toMatchObject({ status: "running", waitKind: null });
      expect(asking.answers.at(-1)).toMatchObject({ asked: "meanwhile" });
      expect(openQuestion(asking)?.question).toStartWith(QUESTION);
    });
    const notice = h.told.find((one) => one.text.includes(QUESTION))!;
    expect(notice.text).toBe(
      `❓ write the report (${short(mission)}) asks, and works on meanwhile: ${QUESTION}\n\nA) take it\nB) leave it out\n\nAnswer: reply to this in your own words, or /mission answer ${short(mission)} <your answer>`,
    );
    expect(notice.buttons!.map((button) => button.label)).toEqual(["A: take it", "B: leave it out"]);
  });

  test("answered while it works: on its record, handed to the turn at work, and nothing is resumed or queued", async () => {
    const { h, handed } = await taking();
    const mission = await h.start();
    const queuedBefore = h.queued.length;
    let acted: ReturnType<typeof h.missions.answer> | undefined;
    h.turn(mission, {}, () => {
      h.missions.ask(mission.id, { question: QUESTION, meanwhile: true });
      acted = h.missions.answer(mission.id, "  ya, masukin  ", "Gading");
      // Still the turn at work: no turn was queued for the answer, and the mission did not wait.
      expect(h.queued).toHaveLength(queuedBefore);
      expect(h.store.get(mission.id)!.status).toBe("running");
    });
    expect(acted).toMatchObject({ said: "Answered. Its coding CLI is given this in the turn it is working on: at once, or once the command it is running ends.", where: "into_cli" });
    // Saved before it was handed over, as a `tell` is, and in the words the turn reads.
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ saved: true, told: { by: "Gading", text: `Answer to your question "${QUESTION}": ya, masukin` } });
    const after = h.store.get(mission.id)!;
    expect(after.answers.at(-1)!.answer).toBe("ya, masukin");
    expect(openQuestion(after)).toBeNull();
    // The turn went on to its end as any turn: the next one is the mission's own, not an answer's.
    expect(after.status).toBe("running");
    expect(h.queued.at(-1)!.text).not.toContain("answered your question");
    expect(h.told.filter((one) => one.text.includes("waits for it now"))).toEqual([]);
  });

  test("a turn that ends with it still open leaves the mission waiting, said once, and the answer is then its next turn", async () => {
    const { h, handed } = await taking();
    const mission = await h.start();
    h.turn(mission, {}, () => void h.missions.ask(mission.id, { question: QUESTION, options: ["take it", "leave it out"], meanwhile: true }));
    expect(h.store.get(mission.id)!).toMatchObject({ status: "waiting", waitKind: "input" });
    // The question once, when it was asked; then that it waits now, with the same buttons. Never the question again as new.
    expect(h.told.filter((one) => one.text.includes("asks"))).toHaveLength(1);
    const waits = h.told.filter((one) => one.text.includes("waits for it now"));
    expect(waits).toHaveLength(1);
    expect(waits[0]!.text).toStartWith(`⏸ write the report (${short(mission)}) has done what it could without your answer, and waits for it now: ${QUESTION}`);
    expect(waits[0]!.buttons!.map((button) => button.label)).toEqual(["A: take it", "B: leave it out"]);

    expect(h.missions.answer(mission.id, "take it", "Gading")).not.toHaveProperty("said");
    expect(h.store.get(mission.id)!.status).toBe("running");
    expect(h.queued.at(-1)!.text).toBe("Gading answered your question: take it");
    // Not handed over as words for a turn at work: none was.
    expect(handed).toEqual([]);
  });

  test("an option's button answers a mission at work", async () => {
    const { h, handed } = await taking({ taken: true, when: "next_step" });
    const mission = await h.start();
    const presses = new OptionPresses({ missions: h.missions, isAdmin: () => false });
    let pressed: Awaited<ReturnType<OptionPresses["press"]>> | undefined;
    const during: Promise<void>[] = [];
    h.turn(mission, {}, () => {
      h.missions.ask(mission.id, { question: QUESTION, options: ["take it", "leave it out"], meanwhile: true });
      const data = h.told.at(-1)!.buttons![1]!.data;
      during.push(presses.press({ data, gatewayId: "telegram:nova", chatId: "8142", chatType: "dm", senderId: "8142", senderName: "Gading" } as never).then((answer) => void (pressed = answer)));
    });
    await Promise.all(during);
    expect(pressed).toEqual({ notice: "Answered. It reads this before its next step.", settled: `❓ Mission ${short(mission)}, answered by Gading: B) leave it out` });
    expect(handed.map((one) => one.told.text)).toEqual([`Answer to your question "${QUESTION}\n\nA) take it\nB) leave it out": B) leave it out`]);
    expect(h.store.get(mission.id)!.answers.at(-1)!.answer).toBe("B) leave it out");
  });

  test("the chat's notes say its mission asks while it works, and no longer once it is answered", async () => {
    const { h } = await taking();
    const mission = await h.start();
    const chat = { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142" };
    const lines = () => h.notes.tasks(chat).map((task) => task.body).join("\n");
    // Its turn is at work for the whole test: the shape is taken and never ended.
    h.missions.shapeFor("nova", h.queued.at(-1)!);
    h.missions.ask(mission.id, { question: QUESTION, meanwhile: true });
    await h.settle();
    expect(lines()).toContain(`waits for the person's answer: "${QUESTION}"`);
    h.missions.answer(mission.id, "ya", "Gading");
    await h.settle();
    expect(lines()).not.toContain("waits for the person's answer");
    expect(lines()).toContain(`mission ${short(mission)}, running`);
  });
});

describe("one question at a time", () => {
  test("a second while one is open is refused in words, and nothing is sent or kept", async () => {
    const { h } = await taking();
    const mission = await h.start();
    h.turn(mission, {}, () => {
      h.missions.ask(mission.id, { question: QUESTION, meanwhile: true });
      h.tick(12 * 60_000);
      const second = h.missions.ask(mission.id, { question: "And the gallery?", meanwhile: true });
      expect(second).toEqual({
        refused: `Your last question has no answer yet (asked 12m ago): "${QUESTION}". One question waits at a time: end your turn and the mission waits for it, or go on with what does not depend on it.`,
      });
      expect(h.told.filter((one) => one.text.includes("And the gallery?"))).toEqual([]);
      expect(h.store.get(mission.id)!.answers).toHaveLength(1);
      // Answered, the next one goes out.
      h.missions.answer(mission.id, "ya", "Gading");
      expect(h.missions.ask(mission.id, { question: "And the gallery?", meanwhile: true })).toMatchObject({ asked: "And the gallery?" });
    });
    // Sent once as a question. The turn then ended with it open, which is said as that and not as the question again.
    expect(h.told.filter((one) => one.text.includes("asks, and works on meanwhile: And the gallery?"))).toHaveLength(1);
    expect(h.told.filter((one) => one.text.includes("And the gallery?"))).toHaveLength(2);
  });

  test("the same question a third time in a row is not sent again, and a person decides", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    for (let round = 1; round <= 3; round += 1) {
      h.turn(h.store.get(mission.id)!, {}, () => {
        const asked = h.missions.ask(mission.id, { question: "Which sheet?" });
        if (round < 3) expect(asked).toMatchObject({ asked: "Which sheet?" });
        else expect(asked).toEqual({ stuck: 'it asked the same question 3 times in a row, going round in circles: "Which sheet?"' });
      });
      if (round < 3) h.missions.answer(mission.id, "the first", "Gading");
    }
    const stuck = h.store.get(mission.id)!;
    expect(stuck).toMatchObject({ status: "waiting", waitKind: "stuck", reason: 'it asked the same question 3 times in a row, going round in circles: "Which sheet?"' });
    // Twice in the chat, and twice on its record: the third never left.
    expect(h.told.filter((one) => one.text.includes("asks: Which sheet?"))).toHaveLength(2);
    expect(stuck.answers).toHaveLength(2);
    expect(openQuestion(stuck)).toBeNull();
  });
});

describe("a question and what else a turn's end finds", () => {
  test("asked, then done in the same turn: the mission is checked, and the question's button says it moved on", async () => {
    const { h } = await taking();
    const mission = await h.start("write it", { checks: ["test -s out.txt"], review: false });
    h.turn(mission, {}, () => {
      h.missions.ask(mission.id, { question: QUESTION, options: ["take it", "leave it out"], meanwhile: true });
      h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Wrote it.", files: [] });
    });
    await h.settle();
    const done = h.store.get(mission.id)!;
    expect(done.status).toBe("done");
    expect(h.told.filter((one) => one.text.includes("waits for it now"))).toEqual([]);
    const data = h.told.find((one) => one.text.includes(QUESTION))!.buttons![0]!.data;
    const pressed = await new OptionPresses({ missions: h.missions, isAdmin: () => false }).press({ data, gatewayId: "telegram:nova", chatId: "8142", chatType: "dm", senderId: "8142", senderName: "Gading" } as never);
    expect(pressed.notice).toBe(`Mission ${short(mission)} has moved on (done), so this question no longer waits.`);
    expect(done.answers.at(-1)!.answer).toBeUndefined();
  });

  test("a turn that failed is tried again, the question as open as it was", async () => {
    const { h } = await taking();
    const mission = await h.start();
    h.turn(mission, { failed: true, error: "rate limit", worked: 0 }, () => void h.missions.ask(mission.id, { question: QUESTION, meanwhile: true }));
    const paused = h.store.get(mission.id)!;
    expect(paused).toMatchObject({ status: "waiting", waitKind: "retry" });
    expect(openQuestion(paused)?.question).toBe(QUESTION);
    expect(h.told.filter((one) => one.text.includes("waits for it now"))).toEqual([]);
  });

  test("it is still open after a restart, and its answer is kept for the turn that follows", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    // The daemon went down with the turn at work: cut short, it decides nothing.
    h.turn(mission, { interrupted: true }, () => void h.missions.ask(mission.id, { question: QUESTION, meanwhile: true }));
    h.restart();
    const open = openQuestion(h.store.get(mission.id)!);
    expect(open).toMatchObject({ question: QUESTION, asked: "meanwhile" });
    expect(h.missions.answer(mission.id, "ya", "Gading")).toMatchObject({ said: "Answered. Kept for its next turn, which reads it first." });
    expect(h.turn(h.store.get(mission.id)!)!.text).toContain(`Asked and answered: 1. Latest: "${QUESTION}" → "ya"`);
  });
});

describe("a line of a mission of an earlier version", () => {
  /** A record as an earlier version left it: a question with no word of how it was asked, on a mission that waits for it or works. */
  const withOld = async (state: "waiting" | "working") => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.turn(mission, {}, () => void h.missions.ask(mission.id, { question: "Which sheet?" }));
    const now = h.store.get(mission.id)!;
    h.store.save({ ...now, answers: [{ question: "Which sheet?", at: 1 }], ...(state === "working" ? { status: "running" as const, waitKind: null, waitingSince: null, reason: null } : {}) });
    return { h, mission };
  };

  test("waiting on its question, it is answered as it always was", async () => {
    const { h, mission } = await withOld("waiting");
    expect(openQuestion(h.store.get(mission.id)!)).toMatchObject({ question: "Which sheet?" });
    h.missions.answer(mission.id, "the first", "Gading");
    expect(h.store.get(mission.id)!.status).toBe("running");
    expect(h.queued.at(-1)!.text).toBe("Gading answered your question: the first");
  });

  test("an unanswered one on a mission doing something else is not a question: it holds nothing back, and no turn's end waits on it", async () => {
    // The third of three alike was kept on the record of a mission that was then stuck, and never sent.
    const { h, mission } = await withOld("working");
    expect(openQuestion(h.store.get(mission.id)!)).toBeNull();
    expect(h.missions.answer(mission.id, "the first", "Gading")).toMatchObject({ why: "no-question" });
    h.turn(h.store.get(mission.id)!);
    expect(h.store.get(mission.id)!.status).toBe("running");
    h.turn(h.store.get(mission.id)!, {}, () => expect(h.missions.ask(mission.id, { question: "And the gallery?" })).toMatchObject({ asked: "And the gallery?" }));
    expect(h.store.get(mission.id)!).toMatchObject({ status: "waiting", waitKind: "input" });
  });
});

describe("`mission` ask, as the agent calls it", () => {
  const setup = async (reach?: "next_step" | "into_cli" | "after_prompt" | null) => {
    const h = await missionsHarness(reach === undefined ? {} : { answerReach: reach });
    const mission = await h.start();
    const tool = createMissionTools(h.missions).inside;
    const ctx = { agentId: "nova", gatewayId: "web:mission", chatId: mission.id, gateway: "web", senderId: "8142", chatType: "dm" } as ToolContext;
    const call = (args: Record<string, unknown>) => tool.execute({ action: "ask", ...args }, ctx);
    return { h, mission, tool, call };
  };
  const endsTurn = (result: { metadata?: unknown }) => (result.metadata as { control?: { finishTurn?: string } } | undefined)?.control?.finishTurn === "end";

  test("plainly, the turn ends there and the mission waits", async () => {
    const { h, mission, call } = await setup();
    let result: Awaited<ReturnType<typeof call>> | undefined;
    const done: Promise<void>[] = [];
    h.turn(mission, {}, () => void done.push(call({ question: "Keep the old sheet?" }).then((answer) => void (result = answer))));
    await Promise.all(done);
    expect(result!.isError).toBe(false);
    expect(result!.content).toBe("Asked. This turn ends here and the mission waits for the answer; it comes back as the next turn.");
    expect(endsTurn(result!)).toBe(true);
  });

  test("with keep_working the turn goes on, told how the answer reaches it and how the mission comes to wait", async () => {
    for (const [reach, words] of [
      ["into_cli", "The answer comes into this turn as soon as they give it."],
      ["next_step", "The answer comes into this turn as soon as they give it."],
      ["after_prompt", "Your CLI takes no words while it works: the answer reaches you only once this turn has ended."],
      [null, "The answer reaches this turn when they give it, or your next one."],
    ] as const) {
      const { mission, call, h } = await setup(reach);
      const result = await call({ question: QUESTION, keep_working: true });
      expect(result.isError).toBe(false);
      expect(endsTurn(result)).toBe(false);
      expect(result.content).toBe(
        `Asked: the question is in their chat now, and this mission stays at work. Go on with what does not depend on the answer, and do nothing that does until it comes. ${words} When nothing is left that can move without it, end your turn: the mission then waits for the answer.`,
      );
      expect(result.content).toBe(keepsWorking(reach));
      expect(h.store.get(mission.id)!.answers.at(-1)).toMatchObject({ asked: "meanwhile" });
    }
  });

  test("a second question is an error the agent reads; the same one a third time ends the turn unsent", async () => {
    const { call } = await setup("into_cli");
    await call({ question: QUESTION, keep_working: true });
    const second = await call({ question: "And the gallery?", keep_working: true });
    expect(second.isError).toBe(true);
    expect(second.content).toStartWith("Your last question has no answer yet");

    const again = await setup();
    for (let round = 1; round <= 2; round += 1) {
      await again.call({ question: "Which sheet?" });
      again.h.turn(again.h.store.get(again.mission.id)!);
      again.h.missions.answer(again.mission.id, "the first", "Gading");
    }
    const third = await again.call({ question: "Which sheet?" });
    expect(third.content).toBe("You have asked this the same way three times in a row, so it was not sent again. This turn ends here, and a person decides how the mission goes on.");
    expect(endsTurn(third)).toBe(true);
  });

  test("the tool and the page say the rule in words", async () => {
    const { tool, h, mission } = await setup();
    const description = tool.definition.description;
    expect(description).toContain('"ask": one `question` for the person, with `options` when the answer is a pick; it reaches them at once and the mission waits for the answer, or with `keep_working` goes on with what does not depend on it.');
    expect(description).toContain("Each ends this turn, but an `ask` with `keep_working`.");
    const field = (tool.definition.parameters as { properties: Record<string, { type: string; description: string }> }).properties.keep_working!;
    expect(field).toEqual({
      type: "boolean",
      description: "ask: true when work is left that does not depend on the answer. The question goes out now, you go on with that work, and the answer comes into your turn. Left out: the mission stops here and waits for the answer.",
    });
    expect(h.turn(mission)!.text).toContain(
      '- Need the person? `mission` action "ask", one question, never `send_message`: what they answer in another chat does not come back to this mission. It reaches them at once and the mission waits for the answer. With work left that does not depend on it, add `keep_working`: you go on, and the answer comes into your turn. Cannot be done? action "fail", with why and what is left.',
    );
  });
});

describe("the ways an answer comes in, to a mission at work", () => {
  const asking = async () => {
    const { h, handed } = await taking({ taken: true, when: "next_step" });
    const mission = await h.start();
    // Its turn is at work for the whole test: the shape is taken and never ended.
    h.missions.shapeFor("nova", h.queued.at(-1)!);
    h.missions.ask(mission.id, { question: QUESTION, meanwhile: true });
    return { h, mission, handed };
  };

  test("/mission answer in its chat says where the answer went", async () => {
    const { h, mission } = await asking();
    const reply = (
      await missionHooks[0]!.handler({
        deps: { missions: h.missions, isAdmin: () => false },
        args: ["answer", short(mission), "ya,", "masukin"],
        gatewayId: "telegram:nova",
        chatId: "8142",
        senderId: "8142",
        agent: { config: { id: "nova" } },
        envelope: { chatType: "dm", senderName: "Gading" },
      } as unknown as HookContext)
    ).reply;
    expect(reply).toBe("Answered. It reads this before its next step.");
    expect(h.store.get(mission.id)!.answers.at(-1)!.answer).toBe("ya, masukin");
  });

  test("the agent passes the answer on with `work`, and is told where it went to say so", async () => {
    const { h, mission } = await asking();
    const work = createWorkTool({
      missions: h.missions,
      plan: () => undefined,
      jobs: { list: () => [], get: () => null, tail: async () => "", kill: () => false },
      approvals: new SqliteApprovalGate({ db: h.db, timeoutMs: 60_000 }),
      speaker: () => ({ name: "Gading", admin: false }),
    });
    const passed = await work.execute({ action: "answer", id: mission.id, text: "ya, masukin" }, { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142", senderId: "8142" } as ToolContext);
    expect(passed.isError).toBe(false);
    expect(passed.content).toBe("Answered. It reads this before its next step.");
    expect(h.store.get(mission.id)!.answers.at(-1)!.answer).toBe("ya, masukin");
  });

  test("the dashboard's route answers it and says so in plain words", async () => {
    const { h, mission } = await asking();
    const control = new Hono<{ Variables: { principal: unknown } }>();
    control.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "operator", role: "operator", user: { id: "usr_operator", username: "operator", displayName: "Gading" } });
      await next();
    });
    registerMissionRoutes(control as never, { ctx: STARTERS_CTX, missions: h.missions, notes: h.notes, approvals: { pending: () => [] }, audit: { record: () => {} } } as never);
    const answered = await control.request(`/missions/${mission.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "ya" }) });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ plain: "Answered. It reads this before its next step.", mission: { status: "running", answers: [{ question: QUESTION, answer: "ya", asked: "meanwhile" }] } });
    // Nothing is open any more: a second answer is refused as it always was.
    const again = await control.request(`/missions/${mission.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "ya" }) });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ plain: "This mission has no question waiting for an answer." });
  });

  test("`nouride mission answer` says where it went, and nothing more for one that waited", async () => {
    const view = { id: "msn_1", agentId: "nix", status: "running", waitKind: null };
    const answers: { path: string; said?: string }[] = [];
    const client = {
      post: async (path: string) => {
        const said = answers.length === 0 ? "Answered. It reads this before its next step." : undefined;
        answers.push({ path, ...(said ? { said } : {}) });
        return { mission: view, ...(said ? { said } : {}) };
      },
    } as unknown as Client;
    const printed: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line?: unknown) => void printed.push(String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "")));
    try {
      await missionCommand(client, ["answer", "msn_1", "ya,", "masukin"]);
      await missionCommand(client, ["answer", "msn_1", "ya"]);
    } finally {
      log.mockRestore();
    }
    expect(answers.map((one) => one.path)).toEqual(["/missions/msn_1/answer", "/missions/msn_1/answer"]);
    expect(printed).toEqual(["✓ msn_1 · running: Answered. It reads this before its next step.", "✓ msn_1 · running"]);
  });

  test("the agent in its chat is told its mission asks and works on, with how to pass the answer on", async () => {
    const { h, mission } = await asking();
    expect(missionQuestions([h.store.get(mission.id)!], "nova", [{ name: "work" }])).toEqual([
      `[Your mission ${mission.id} asked this person a question and works on meanwhile: "${QUESTION}" If this message answers it, pass the answer on with work (action "answer", id ${mission.id}) and say that you did: it is the answer the mission asked for, not a repeat.]`,
    ]);
    h.missions.answer(mission.id, "ya", "Gading");
    expect(missionQuestions([h.store.get(mission.id)!], "nova", [{ name: "work" }])).toEqual([]);
  });
});
