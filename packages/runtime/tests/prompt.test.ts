/**
 * A line prompt over a pipe rather than a terminal: each line a script sends goes to one question, in order.
 *
 * `question()` receives only a line that arrives while it waits, so a script's lines — all arriving at once — went to
 * nobody after the first, and a last line with no newline left the question waiting for good.
 */

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { openLinePrompt } from "../src/prompt.ts";
import { sleep } from "./wait.ts";

function piped() {
  const input = new PassThrough();
  const written: string[] = [];
  const prompt = openLinePrompt({ input, output: { write: (chunk: string) => written.push(chunk) } });
  return { input, prompt, written };
}

const tick = (ms = 20) => sleep(ms);

/** How a question came out, or that it had not within a second — a refusal that never comes is a hang, not a fail. */
const outcome = (question: Promise<string>) =>
  Promise.race([
    question.then(
      (line) => `answered ${line}`,
      (err: Error) => `refused: ${err.message}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 1000)),
  ]);

describe("openLinePrompt over a pipe", () => {
  test("lines that arrive before anyone asks are kept for the questions that follow", async () => {
    const { input, prompt } = piped();
    input.end("one\ntwo\nthree\n");
    await tick();
    expect(await prompt.ask("> ")).toBe("one");
    await tick(); // an answer being waited on, as a chat waits on its turn
    expect(await prompt.ask("> ")).toBe("two");
    expect(await prompt.ask("> ")).toBe("three");
  });

  test("a question asked before its line arrives gets it when it does", async () => {
    const { input, prompt } = piped();
    const asked = prompt.ask("> ");
    input.write("late\n");
    expect(await outcome(asked)).toBe("answered late");
    input.end();
  });

  test("a last line with no newline is a line", async () => {
    const { input, prompt } = piped();
    input.end("one\nlast");
    expect(await prompt.ask("> ")).toBe("one");
    expect(await prompt.ask("> ")).toBe("last");
  });

  test("past the last line a question is refused — asked after the end, or waiting when it came", async () => {
    const { input, prompt } = piped();
    const waiting = prompt.ask("> ");
    input.end();
    expect(await outcome(waiting)).toBe("refused: the input ended");
    expect(await outcome(prompt.ask("> "))).toBe("refused: the input ended");
  });

  test("each line is written after its question, a hidden one not at all, and no question past the last", async () => {
    const { input, prompt, written } = piped();
    input.end("visible\nsecret\n");
    await tick();
    await prompt.ask("you › ");
    await prompt.askHidden("key: ");
    await expect(prompt.ask("you › ")).rejects.toThrow("the input ended");
    expect(written.join("")).toBe("you › visible\nkey: \n");
  });
});
