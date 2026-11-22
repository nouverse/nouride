/**
 * Several at the same time, as the editor holds one: each of the steps it starts named by its step's id and its
 * place, what the page refuses before the server would, what it is called on a card and over its words, and what
 * becomes of it when its kind is changed. Pure, as `automation-steps.test.ts` is for a list.
 */

import { describe, expect, test } from "bun:test";
import { copyOnLine } from "@/modules/automations/lib/paths";
import { TOGETHER_MAX, argvOf, asKind, asPart, blankPart, blankStep, canWatch, exitsOf, mainText, parted, stepProblems, type Part, type Step } from "@/modules/automations/lib/steps";
import { KIND, partTitle, stepLine, stepTitle } from "@/modules/automations/lib/words";
import { payloadOf } from "@/modules/automations/lib/draft";

type Together = Extract<Step, { kind: "parallel" }>;
const news: Part = { id: "x", kind: "agentTurn", message: "Read the news.", agentId: "nix" };
const tickets: Part = { id: "y", kind: "command", argv: argvOf("gh issue list") };
const group = (parts: Part[], over: Partial<Together> = {}): Together => parted({ id: "s1", kind: "parallel", steps: parts, ...over });
const said = (steps: Step[], own = "nouva") => stepProblems(steps, own).map((problem) => problem.message);

describe("the steps it starts", () => {
  test("are named by their step's id and their place, however they were written, added to or copied", () => {
    expect(group([news, tickets]).steps.map((part) => part.id)).toEqual(["s1-1", "s1-2"]);
    // A new one starts with two to write, already named.
    const fresh = blankStep("parallel", []) as Together;
    expect(fresh).toEqual({ id: "s1", kind: "parallel", steps: [{ id: "s1-1", kind: "agentTurn", message: "" }, { id: "s1-2", kind: "agentTurn", message: "" }] });
    // One taken out of the middle: the rest are named by where they now stand, so no two share a name.
    const three = group([news, tickets, blankPart("agentTurn")]);
    expect(parted(three, three.steps.filter((_, at) => at !== 0)).steps.map((part) => part.id)).toEqual(["s1-1", "s1-2"]);
    // A long step id leaves room for the place.
    expect(group([news, tickets], { id: "a".repeat(24) }).steps[1]!.id).toBe(`${"a".repeat(21)}-2`);
    // A copy has an id of its own, and so have the steps it starts: the server refuses an id two steps share.
    const copied = copyOnLine([group([news, tickets])], 0);
    expect(copied.map((step) => step.id)).toEqual(["s1", "s2"]);
    expect((copied[1] as Together).steps.map((part) => part.id)).toEqual(["s2-1", "s2-2"]);
  });

  test("one changed to the other kind keeps its name and its words, and drops an agent with the turn it was for", () => {
    expect(asPart({ ...news, name: "News" }, "command")).toEqual({ id: "x", name: "News", kind: "command", argv: ["sh", "-lc", "Read the news."] });
    expect(asPart(tickets, "agentTurn")).toEqual({ id: "y", kind: "agentTurn", message: "gh issue list" });
    expect(asPart(news, "agentTurn")).toBe(news);
  });
});

describe("what the page refuses before the server would", () => {
  test("fewer than two, more than five, one with nothing written, and an agent with two of them", () => {
    expect(said([group([news])])).toEqual(["Add at least two things to start at the same time."]);
    expect(said([group(Array.from({ length: TOGETHER_MAX + 1 }, (_, n) => ({ ...news, agentId: `a${n}` })))])).toEqual(["At most 5 start at the same time."]);
    expect(said([group([news, blankPart("agentTurn")])])).toEqual(["Write what each of them does: what to ask, or the command to run."]);
    expect(said([group([news, { ...tickets, argv: [] }])])).toEqual(["Write what each of them does: what to ask, or the command to run."]);
    const twice = "An agent takes one of these at a time. Give each a different agent, or move one to a step of its own.";
    expect(said([group([news, { ...news, message: "Again." }])])).toEqual([twice]);
    // Left unsaid, the agent is the automation's own: one that names it is the same agent.
    expect(said([group([{ id: "", kind: "agentTurn", message: "Mine." }, { id: "", kind: "agentTurn", message: "Also mine.", agentId: "nouva" }])])).toEqual([twice]);
    expect(said([group([{ id: "", kind: "agentTurn", message: "Mine." }, { id: "", kind: "agentTurn", message: "Also mine." }])])).toEqual([twice]);
    // Two commands, or two agents and a command, are fine.
    expect(said([group([tickets, { ...tickets, argv: argvOf("date") }])])).toEqual([]);
    expect(said([group([news, { id: "", kind: "agentTurn", message: "Mine." }, tickets])])).toEqual([]);
  });

  test("it is only ever a step of a list, with a step's three paths, and may go on only when what they said changes", () => {
    const step = group([news, tickets]);
    expect(payloadOf({ steps: [step], then: "deliver", list: false })).toEqual({ kind: "steps", steps: [step] });
    expect(exitsOf(step)).toEqual(["then", "whenFailed", "whenEmpty"]);
    expect(canWatch(step)).toBe(true);
  });
});

describe("what it is called", () => {
  test("on its card, in the picker, and each of them over its words", () => {
    const step = group([news, tickets, { ...news, agentId: "nox" }]);
    expect(stepTitle(step, "Nouva")).toBe("3 at the same time");
    expect(stepTitle({ ...step, name: "Ask them" }, "Nouva")).toBe("Ask them");
    expect(stepLine(step)).toBe("Read the news. · gh issue list · Read the news.");
    expect(mainText(group([news, blankPart("agentTurn")]))).toBe("Read the news.");
    expect(KIND.parallel.label).toBe("Several at the same time");
    // A person's name for it, or whose turn it is, or the command: what its words are joined under.
    expect([partTitle({ ...news, name: "News" }, "Nix"), partTitle(news, "Nix"), partTitle(tickets, "")]).toEqual(["News", "Nix", "gh issue list"]);
  });

  test("changed to another kind it is the first of them; another kind changed to it is its first, with a second to write", () => {
    const step = group([news, tickets], { name: "Ask them", whenFailed: "next" });
    expect(asKind(step, "agentTurn")).toEqual({ id: "s1", name: "Ask them", whenFailed: "next", kind: "agentTurn", message: "Read the news.", agentId: "nix" });
    expect(asKind({ id: "s3", kind: "command", argv: argvOf("date"), whenEmpty: "next" }, "parallel")).toEqual({
      id: "s3",
      whenEmpty: "next",
      kind: "parallel",
      steps: [{ id: "s3-1", kind: "command", argv: ["sh", "-lc", "date"] }, { id: "s3-2", kind: "agentTurn", message: "" }],
    });
    expect((asKind({ id: "s4", kind: "agentTurn", message: "Look.", agentId: "nix" }, "parallel") as Together).steps[0]).toEqual({ id: "s4-1", kind: "agentTurn", message: "Look.", agentId: "nix" });
    // A message's words become what the first agent is asked.
    expect((asKind({ id: "s5", kind: "systemEvent", text: "Good morning." }, "parallel") as Together).steps[0]).toEqual({ id: "s5-1", kind: "agentTurn", message: "Good morning." });
  });
});
