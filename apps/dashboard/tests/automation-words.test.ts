/**
 * What a step and its paths are called (`modules/automations/lib/words.ts`): the words a person who does not run the
 * server reads on a card, in its editor and under it. Each says what happens, never how it is stored.
 */

import { describe, expect, test } from "bun:test";
import type { Step } from "@/modules/automations/lib/steps";
import { KIND, START, choiceWords, endWords, exitAsks, exitChip, exitGoes, sameAgainWords, stepFacts, stepLine, stepTitle } from "@/modules/automations/lib/words";

const command: Step = { id: "a", kind: "command", argv: ["sh", "-lc", "curl -sf  https://shop.example.com/health"] };
const turn: Step = { id: "b", kind: "agentTurn", message: "Find out why.\nSay what you found." };
const wait: Step = { id: "c", kind: "approval", ask: "Send it?" };
const say: Step = { id: "d", kind: "systemEvent", name: "Tell me", text: "It failed." };
const mission: Step = { id: "e", kind: "mission", goal: "Fix it." };

const script: Extract<Step, { kind: "command" }> = { id: "f", kind: "command", argv: ["python3"], script: { text: "print('saved')\n", about: "Saves the summary to Notion", by: "agent:nix" } };

describe("a step's words", () => {
  test("its title is the name a person gave it, or what its kind does, an agent's step by whose it is", () => {
    expect(stepTitle(command, "Nix")).toBe("Run a script");
    // A script is called by what it is said to do: its own line is only the program that runs it.
    expect(stepTitle(script, "Nix")).toBe("Saves the summary to Notion");
    expect(stepTitle({ ...script, name: "Save it" }, "Nix")).toBe("Save it");
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
    // A script's title already says what it does: its line says what it is and who wrote it, never its program.
    expect(stepLine(script, (id) => (id === "nix" ? "Nix" : id))).toBe("A script Nix wrote · no AI");
    expect(stepLine({ ...script, script: { ...script.script!, by: "web:usr_1" } }, (id) => id)).toBe("A script · no AI");
    expect(stepLine(script)).toBe("A script · no AI");
  });

  test("what its box says besides its paths: who a lone command hands what it printed to, and that it goes on only when what it says changes", () => {
    expect(stepFacts(command)).toEqual([]);
    expect(stepFacts(command, "Nix")).toEqual(["Then Nix reads what it printed and reports."]);
    // Only a command hands its output on that way.
    expect(stepFacts(turn, "Nix")).toEqual([]);
    const said = "It goes on only when what it says changes.";
    expect(stepFacts({ ...command, onlyChanged: true })).toEqual([said]);
    expect(stepFacts({ ...command, onlyChanged: true }, "Nix")).toEqual(["Then Nix reads what it printed and reports.", said]);
    expect(stepFacts({ ...turn, onlyChanged: true })).toEqual([said]);
    expect(stepFacts({ ...mission, onlyChanged: true })).toEqual([said]);
    // A kind that cannot hold the mark never says it.
    expect(stepFacts({ ...say, onlyChanged: true })).toEqual([]);
    expect(stepFacts({ ...wait, onlyChanged: true })).toEqual([]);
  });

  test("what the run does when a marked step says the same again: it ends quietly, or goes where its path for nothing to say leads", () => {
    const quiet = "If it says the same as last time, the run ends here quietly.";
    expect(sameAgainWords([command, turn], 0)).toBe(quiet);
    // The last step, wherever its path points: there is nothing to go on to.
    expect(sameAgainWords([command, { ...turn, whenEmpty: "next" }], 1)).toBe(quiet);
    // A mission has told its chat how it went by then, so its run's end is not called quiet.
    expect(sameAgainWords([mission, turn], 0)).toBe("If it says the same as last time, the run ends here.");
    const led = 'If it says the same as last time, the run goes where "With nothing to say" sends it.';
    expect(sameAgainWords([{ ...command, whenEmpty: "next" }, turn], 0)).toBe(led);
    expect(sameAgainWords([{ ...command, whenEmpty: { to: "d" } }, turn, say], 0)).toBe(led);
  });

  test("every kind and every start has an icon, a name and a soft colour of the theme's own", () => {
    for (const look of [...Object.values(KIND), ...Object.values(START)]) {
      expect(look.label.length).toBeGreaterThan(3);
      // A semantic colour, never a palette class or a hex.
      expect(look.tile).toMatch(/^bg-(primary|secondary|accent|info|success|base-content)\/\S+ text-(primary|secondary|accent|info|success|base-content)(\/\d+)?$/);
    }
    expect(Object.keys(KIND).sort()).toEqual(["agentTurn", "approval", "command", "mission", "parallel", "systemEvent"]);
    // Pink is what needs you, and nothing else: the wait for a person alone.
    expect(Object.entries(KIND).filter(([, look]) => look.tile.includes("accent")).map(([kind]) => kind)).toEqual(["approval"]);
  });
});

describe("a path's words", () => {
  const steps = [{ ...command, then: "end", whenFailed: "next", whenEmpty: { to: "d" } } as Step, turn, wait, say];
  const title = (step: Step) => stepTitle(step, "Nix");

  test("the answers a path can be given are called by what a person would ask for, and each says what the run then does", () => {
    expect(choiceWords(command, "whenFailed", "stop")).toEqual({ label: "Stop and tell me", hint: "The run ends, and its chat is told why." });
    // Silence is no failure: it ends without a word to anyone.
    expect(choiceWords(command, "whenEmpty", "stop")).toEqual({ label: "Stop quietly", hint: "The run ends, and nobody is told." });
    // A no to a wait is an answer, not a failure.
    expect(choiceWords(wait, "whenFailed", "stop")).toEqual({ label: "Stop there", hint: "The run ends. Nothing is counted as failed." });
    // What the daemon hands on: a script reads what the failed step had been given, and an agent is told the error too.
    expect(choiceWords(command, "whenFailed", "goOn")).toEqual({ label: "Go on anyway", hint: "The next step gets what this step was given. An agent is also told why it failed." });
    expect(choiceWords(wait, "whenFailed", "goOn").hint).toBe("The next step is told the answer was no.");
    expect(choiceWords(command, "whenEmpty", "goOn").hint).toBe("The next step runs with nothing handed to it.");
    expect(choiceWords(command, "whenFailed", "ask")).toEqual({ label: "Ask me first", hint: "Yes goes on, no stops here." });
    expect(choiceWords(command, "whenFailed", "lane")).toEqual({ label: "Do something else", hint: "Other steps run in its place." });
    // One the page did not write is said as it is, with how to change it.
    expect(choiceWords(command, "whenFailed", "jump", "step 4, Tell me")).toEqual({ label: "Go to step 4, Tell me", hint: "Set from elsewhere. Pick another answer to change it." });
  });

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
