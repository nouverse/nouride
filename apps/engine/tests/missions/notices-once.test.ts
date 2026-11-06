/**
 * What a mission says in its chat, read once (0.8.7): *started* with its goal whole (0.8.11) and how to stop it, a
 * question never clipped unsaid, a button for each option a question names, and one progress message rewritten where the
 * chat can edit.
 */

import { describe, expect, test } from "bun:test";
import type { ButtonPress } from "@nouride/shared";
import { doneNotice, needsYouNotice, paged, QUESTION_CHARS, startedNotice } from "@/modules/missions/notices.ts";
import { OptionPresses, optionButtons, optionsIn } from "@/modules/missions/options.ts";
import { ProgressLines } from "@/modules/missions/progress-line.ts";
import { missionsHarness } from "./harness.ts";

const BASE = { id: "msn_0123456789abcdef0123", goal: "Fix the login bug\nThe brief goes on for pages: …", checks: ["bun test", "bun run lint"], reviewOn: true, accept: false, jobId: null };

describe("started", () => {
  test("the goal whole, then the checks counted, the reviewer, how to stop it — the checks themselves are in /mission show", () => {
    expect(startedNotice(BASE)).toBe("▶ msn_012345: Fix the login bug\nThe brief goes on for pages: …\n\n2 checks + reviewer · stop: /mission stop msn_012345");
    expect(startedNotice(BASE)).not.toContain("bun test");
  });

  test("no checks and no reviewer: the person accepts; one check is one", () => {
    expect(startedNotice({ ...BASE, checks: [], reviewOn: false })).toEndWith("\n\nyou accept · stop: /mission stop msn_012345");
    expect(startedNotice({ ...BASE, checks: ["x"], reviewOn: false, accept: true })).toContain("\n\n1 check + you accept ·");
  });

  test("a goal of 1,900 characters is carried whole (0.8.11): cut to its first line, a person read half of what was asked", () => {
    const goal = `${"Rewrite the parser and keep every test green. ".repeat(40)}\nThen the docs.`;
    expect(goal.length).toBeGreaterThan(1_800);
    const notice = startedNotice({ ...BASE, goal });
    expect(notice).toContain(goal.trim());
    expect(notice).not.toContain("…");
  });
});

describe("each part of a notice is its own paragraph (0.8.11)", () => {
  // In WhatsApp, Nouva's done notice to a person read as one block: "Mission … done", the result and "Branch: …" ran
  // together, each on the next line. The owner asked for an empty line between them.
  const worked = { id: BASE.id, summary: "Lima dokumen sudah diaudit.", reviewed: true, checks: ["x"], workdir: `/srv/w/missions/${BASE.id}/worktree`, branch: null, reason: null };
  const page = `https://box/dashboard/missions/${BASE.id}`;

  test("done: how it ended, then its result, its branch, its page", () => {
    expect(paged(doneNotice(worked, false), page)).toBe(`✓ Mission msn_012345 done (checks passed, reviewed).\n\nLima dokumen sudah diaudit.\n\nBranch: mission/${BASE.id}\n\nPage: ${page}`);
  });

  test("waiting for the person's yes: what passed, its result, the reviewer's words, its branch, how to accept it", () => {
    expect(needsYouNotice(worked, "accept", "The reviewer: the totals add up.")).toBe(
      `☑ Mission msn_012345 passed its checks.\n\nLima dokumen sudah diaudit.\n\nThe reviewer: the totals add up.\n\nBranch: mission/${BASE.id}\n\nAccept: /mission accept msn_012345, or /mission continue msn_012345 with what is missing.`,
    );
  });

  test("a question, then how to answer it; started, its goal, then how it is judged and stopped", () => {
    expect(needsYouNotice(worked, "input", "Which sheet?")).toBe("❓ Mission msn_012345 asks: Which sheet?\n\nAnswer: reply to this in your own words, or /mission answer msn_012345 <your answer> · or accept it as it is: /mission accept msn_012345");
    expect(paged(startedNotice({ ...BASE, goal: "Audit KK 1.3a" }), page)).toBe(`▶ msn_012345: Audit KK 1.3a\n\n2 checks + reviewer · stop: /mission stop msn_012345\n\nPage: ${page}`);
  });
});

describe("a question is never clipped unsaid", () => {
  const where = { id: BASE.id, checks: [], workdir: "/w", branch: null, summary: null };

  test("a long question is carried whole, its options at the end included", () => {
    const question = `${"Context. ".repeat(150)}\nA) keep it\nB) drop it`;
    const notice = needsYouNotice(where, "input", question);
    expect(notice).toContain("A) keep it\nB) drop it");
    expect(notice).not.toContain("…");
  });

  test("past what one notice carries, it says where the rest is", () => {
    const notice = needsYouNotice(where, "input", "x".repeat(QUESTION_CHARS + 50));
    expect(notice).toContain("(The question goes on: /mission show msn_012345 has all of it)");
  });
});

describe("options a question names", () => {
  test("one per line, in the usual spellings", () => {
    expect(optionsIn("Which way?\nA) merge now\nB) wait for Nox\nC) drop it")).toEqual([
      { key: "A", text: "merge now" },
      { key: "B", text: "wait for Nox" },
      { key: "C", text: "drop it" },
    ]);
    expect(optionsIn("Pick:\n- **A.** fast\n- **B.** safe").map((one) => one.key)).toEqual(["A", "B"]);
    expect(optionsIn("(A) yes\n(B) no").map((one) => one.text)).toEqual(["yes", "no"]);
  });

  test("on one line", () => {
    expect(optionsIn("Should I A) keep the flag, B) remove it, or C) ask Nox?")).toEqual([
      { key: "A", text: "keep the flag" },
      { key: "B", text: "remove it" },
      { key: "C", text: "ask Nox" },
    ]);
  });

  test("numbered, as an agent writes them as often as lettered — six of them, as many as letters take", () => {
    // Live on Discord (0.8.12): Nouva asked "Which colour do you prefer?" over six numbered lines, and the question went
    // out with no buttons — only A) to F) were read as options.
    expect(optionsIn("Which colour do you prefer?\n1. red\n2. orange\n3. yellow\n4. green\n5. blue\n6. purple").map((one) => `${one.key} ${one.text}`)).toEqual([
      "1 red", "2 orange", "3 yellow", "4 green", "5 blue", "6 purple",
    ]);
    expect(optionsIn("Should I 1) keep the flag, 2) remove it, or 3) ask Nox?").map((one) => one.key)).toEqual(["1", "2", "3"]);
    // One kind of marker: a list that mixes them, or starts past 1, is not a choice this reads.
    expect(optionsIn("1. one\nB) two")).toEqual([]);
    expect(optionsIn("2. one\n3. two")).toEqual([]);
  });

  test("none: a single option, letters out of order, or no options at all", () => {
    expect(optionsIn("A) the only one")).toEqual([]);
    expect(optionsIn("B) one\nA) two")).toEqual([]);
    expect(optionsIn("Should I merge it or not?")).toEqual([]);
  });

  test("buttons carry the mission, the question and the letter, within Telegram's 64 bytes", () => {
    const askedAt = Date.UTC(2099, 11, 31);
    const buttons = optionButtons(BASE.id, optionsIn("A) merge now\nB) a very long option text that goes on and on past the label"), askedAt);
    const stamp = askedAt.toString(36);
    expect(buttons.map((button) => button.data)).toEqual([`mission:answer:${BASE.id}:${stamp}:A`, `mission:answer:${BASE.id}:${stamp}:B`]);
    for (const button of buttons) expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64);
    expect(buttons[1]!.label.length).toBeLessThanOrEqual(40);
  });
});

describe("answering by a button", () => {
  const press = (over: Partial<ButtonPress>): ButtonPress => ({ gatewayId: "telegram:nova", chatId: "8142", chatType: "dm", messageId: "m1", data: "", senderId: "8142", senderName: "Gading", ...over });

  test("the question goes with its buttons; a press answers with the option's words, and the mission goes on", async () => {
    const h = await missionsHarness();
    const presses = new OptionPresses({ missions: h.missions, isAdmin: () => false });
    const mission = await h.start();
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "Which?\nA) merge now\nB) wait for Nox" }));
    const sent = h.told.at(-1)!.buttons!.map((button) => button.data);
    const stamp = h.store.get(mission.id)!.answers.at(-1)!.at.toString(36);
    expect(sent).toEqual([`mission:answer:${mission.id}:${stamp}:A`, `mission:answer:${mission.id}:${stamp}:B`]);
    const answer = await presses.press(press({ data: sent[1]! }));
    expect(answer.notice).toBe("Answered B.");
    expect(h.store.get(mission.id)!.status).toBe("running");
    expect(h.queued.at(-1)!.text).toContain("Gading answered your question: B) wait for Nox");
    // A second press finds it answered.
    expect((await presses.press(press({ data: sent[0]! }))).notice).toBe("That question is already answered.");
  });

  test("a numbered option's button answers with its number and words", async () => {
    const h = await missionsHarness();
    const presses = new OptionPresses({ missions: h.missions, isAdmin: () => false });
    const mission = await h.start();
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "Which colour?\n1. red\n2. blue" }));
    const buttons = h.told.at(-1)!.buttons!;
    expect(buttons.map((button) => button.label)).toEqual(["1: red", "2: blue"]);
    expect((await presses.press(press({ data: buttons[1]!.data }))).notice).toBe("Answered 2.");
    expect(h.queued.at(-1)!.text).toContain("Gading answered your question: 2) blue");
  });

  test("a button left under an earlier question does not answer the one asked after it", async () => {
    const h = await missionsHarness();
    const presses = new OptionPresses({ missions: h.missions, isAdmin: () => false });
    const mission = await h.start();
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "First?\nA) red\nB) blue" }));
    const first = h.told.at(-1)!.buttons!.map((button) => button.data);
    h.missions.answer(mission.id, "blue, typed", "Gading");
    h.tick(60_000);
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "Second?\nA) delete it\nB) keep it" }));
    const pressed = await presses.press(press({ data: first[0]! }));
    expect(pressed).toEqual({ notice: "It has asked another question since: answer that one.", settled: `❓ Mission ${mission.id.slice(0, 10)}: asked something else since.` });
    expect(h.store.get(mission.id)).toMatchObject({ status: "waiting", waitKind: "input" });
    expect(h.store.get(mission.id)!.answers.at(-1)!.answer).toBeUndefined();
  });

  test("refused from another chat, and in a room from someone who did not start it", async () => {
    const h = await missionsHarness();
    const presses = new OptionPresses({ missions: h.missions, isAdmin: () => false });
    const mission = await h.start();
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "A) yes\nB) no" }));
    const a = h.told.at(-1)!.buttons![0]!.data;
    expect((await presses.press(press({ chatId: "other", data: a }))).notice).toBe("That mission does not report to this chat.");
    expect((await presses.press(press({ chatType: "group", senderId: "stranger", data: a }))).notice).toContain("Only the person who started");
    expect(h.store.get(mission.id)!.waitKind).toBe("input");
  });

  test("a question with no options goes without buttons", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "What should the file be called?" }));
    expect(h.told.at(-1)!.buttons).toBeUndefined();
  });
});

describe("one progress message", () => {
  function chat(canEdit: boolean) {
    const sends: string[] = [];
    const edits: string[] = [];
    return {
      sends,
      edits,
      lines: new ProgressLines({
        send: async (_to, text) => (sends.push(text), `m${sends.length}`),
        edit: async (_to, id, text) => (canEdit ? (edits.push(`${id}:${text}`), true) : false),
      }),
    };
  }
  const to = { gatewayId: "telegram:nova", chatId: "8142" };

  test("where the chat can edit, the first is sent and the rest rewrite it", async () => {
    const { sends, edits, lines } = chat(true);
    await lines.say("msn_1", to, "1 of 5");
    await lines.say("msn_1", to, "2 of 5");
    await lines.say("msn_1", to, "3 of 5");
    expect(sends).toEqual(["1 of 5"]);
    expect(edits).toEqual(["m1:2 of 5", "m1:3 of 5"]);
  });

  test("where it cannot, each is a new message, as before; and a mission that ended starts over", async () => {
    const { sends, lines } = chat(false);
    await lines.say("msn_1", to, "1 of 5");
    await lines.say("msn_1", to, "2 of 5");
    expect(sends).toEqual(["1 of 5", "2 of 5"]);
    lines.forget("msn_1");
    expect(lines.size).toBe(0);
  });
});
