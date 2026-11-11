/**
 * What a step and its paths are called (`modules/automations/lib/words.ts`): the words a person who does not run the
 * server reads on a card, in its editor and under it. Each says what happens, never how it is stored.
 */

import { describe, expect, test } from "bun:test";
import type { Step } from "@/modules/automations/lib/steps";
import { KIND, START, endWords, exitAsks, exitChip, exitGoes, stepLine, stepNote, stepTitle } from "@/modules/automations/lib/words";

const command: Step = { id: "a", kind: "command", argv: ["sh", "-lc", "curl -sf  https://shop.example.com/health"] };
const turn: Step = { id: "b", kind: "agentTurn", message: "Find out why.\nSay what you found." };
const wait: Step = { id: "c", kind: "approval", ask: "Send it?" };
const say: Step = { id: "d", kind: "systemEvent", name: "Tell me", text: "It failed." };
const mission: Step = { id: "e", kind: "mission", goal: "Fix it." };

describe("a step's words", () => {
  test("its title is the name a person gave it, or what its kind does, an agent's step by whose it is", () => {
    expect(stepTitle(command, "Nix")).toBe("Run a command");
    expect(stepTitle(turn, "Nix")).toBe("Nix works on it");
    expect(stepTitle(wait, "Nix")).toBe("Wait for your OK");
    expect(stepTitle(mission, "Nix")).toBe("Start a mission");
    expect(stepTitle(say, "Nix")).toBe("Tell me");
    expect(stepTitle({ ...say, name: "  " }, "Nix")).toBe("Send a message");
  });

  test("its line is what it runs, says or asks, on one line", () => {
    expect(stepLine(command)).toBe("curl -sf https://shop.example.com/health");
    expect(stepLine(turn)).toBe("Find out why. Say what you found.");
    expect(stepLine(wait)).toBe("Send it?");
  });

  test("its note says what it costs or waits for, and a lone command that hands its output on says to whom", () => {
    expect(stepNote(command, 0)).toBe("No AI is used for this step.");
    expect(stepNote(command, 0, "Nix")).toBe("No AI runs it. Then Nix reads what it printed and reports.");
    expect(stepNote(say, 3)).toBe("Sent as written to where it reports. No AI.");
    expect(stepNote(turn, 0)).toBe("It works with its tools, and what it says goes on.");
    expect(stepNote(turn, 1)).toBe("It is handed what the step before said.");
    expect(stepNote(mission, 1)).toBe("The run waits here until the mission ends.");
    expect(stepNote(wait, 2)).toBe("The run waits up to 1 day for your answer.");
    expect(stepNote({ ...wait, timeoutMs: 5 * 60_000 }, 2)).toBe("The run waits up to 5 minutes for your answer.");
    expect(stepNote({ ...wait, timeoutMs: 3 * 86_400_000 }, 2)).toBe("The run waits up to 3 days for your answer.");
    expect(stepNote({ ...wait, timeoutMs: 4 * 3_600_000 }, 2)).toBe("The run waits up to 4 hours for your answer.");
  });

  test("every kind and every start has an icon, a name and a soft colour of the theme's own", () => {
    for (const look of [...Object.values(KIND), ...Object.values(START)]) {
      expect(look.label.length).toBeGreaterThan(3);
      // A semantic colour, never a palette class or a hex.
      expect(look.tile).toMatch(/^bg-(primary|secondary|accent|info|success|base-content)\/\S+ text-(primary|secondary|accent|info|success|base-content)(\/\d+)?$/);
    }
    expect(Object.keys(KIND).sort()).toEqual(["agentTurn", "approval", "command", "mission", "systemEvent"]);
    // Pink is what needs you, and nothing else: the wait for a person alone.
    expect(Object.entries(KIND).filter(([, look]) => look.tile.includes("accent")).map(([kind]) => kind)).toEqual(["approval"]);
  });
});

describe("a path's words", () => {
  const steps = [{ ...command, then: "end", whenFailed: "next", whenEmpty: { to: "d" } } as Step, turn, wait, say];
  const title = (step: Step) => stepTitle(step, "Nix");

  test("what happened for the run to take it: in the editor as a question, under the card as a chip", () => {
    expect([exitAsks(command, "then"), exitAsks(command, "whenFailed"), exitAsks(command, "whenEmpty")]).toEqual(["When it is done", "When it fails", "When it has nothing to say"]);
    expect([exitChip(command, "then"), exitChip(command, "whenFailed"), exitChip(command, "whenEmpty")]).toEqual(["Once done", "If it fails", "With nothing to say"]);
    // A wait for a person ends in a yes or a no, not in done or failed.
    expect([exitAsks(wait, "then"), exitAsks(wait, "whenFailed")]).toEqual(["When you say yes", "When you say no, or nobody answers"]);
    expect([exitChip(wait, "then"), exitChip(wait, "whenFailed")]).toEqual(["After your yes", "If you say no"]);
  });

  test("where it leads: on, the end, or a later step by its number and title", () => {
    expect(exitGoes(steps, 0, "then", title)).toBe("end here");
    expect(exitGoes(steps, 0, "whenFailed", title)).toBe("go on");
    expect(exitGoes(steps, 0, "whenEmpty", title)).toBe("step 4, Tell me");
    // From the last step, on is the end too, said as going on: the run finishes either way.
    expect(exitGoes(steps, 3, "then", title)).toBe("go on");
  });

  test("ending the run means something else on each path", () => {
    expect([endWords("then"), endWords("whenFailed"), endWords("whenEmpty")]).toEqual(["End the run here", "End the run, as failed", "End the run quietly"]);
  });
});
