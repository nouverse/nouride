/**
 * A message a coding CLI was sent and did not answer, in words: refused, with what the CLI said, or the CLI gone while
 * it worked. A turn an account's limit refused read "Claude Code did not start: session/prompt: Internal error: You've
 * reached your Fable limit", and the chat it failed in kept asking the model picked there with nothing saying so.
 */

import { describe, expect, test } from "bun:test";
import { AcpError, INTERNAL_ERROR, type CliRow } from "@nouride/acp";
import { promptFailed, unavailableReason } from "@/modules/external-agents/connection.ts";
import { pickedNote } from "@/modules/external-agents/models.ts";

const row = { id: "claude-code", name: "Claude Code", command: "claude-agent-acp", install: "npm i -g it" } as CliRow;
const LIMIT = "You've reached your Fable limit. Switch to another model to continue.";

describe("a message the CLI did not answer", () => {
  test("refused: the CLI's own words, without the call's name or the protocol's phrase for its code", () => {
    const refused = new AcpError(INTERNAL_ERROR, `session/prompt: Internal error: ${LIMIT}`);
    expect(promptFailed(row, refused, false)).toBe(`Claude Code refused the message: ${LIMIT}`);
    // The start's words, for the same error, are the ones that misled: kept for a CLI that did not start.
    expect(unavailableReason(row, refused, [])).toBe(`Claude Code did not start: session/prompt: Internal error: ${LIMIT}`);
  });

  test("the protocol's phrase is taken off only under its own code: another refusal's words are the CLI's", () => {
    expect(promptFailed(row, new AcpError(-32602, "session/prompt: Internal error: not this code's phrase"), false)).toBe("Claude Code refused the message: Internal error: not this code's phrase");
    expect(promptFailed(row, new Error("the pipe broke\nat line 2"), false)).toBe("Claude Code refused the message: the pipe broke");
  });

  test("the CLI gone while it worked is said as that", () => {
    expect(promptFailed(row, new AcpError(-32099, "session/prompt: the connection closed (exited with code 137)"), true)).toBe("Claude Code stopped while it answered: the connection closed (exited with code 137)");
  });

  test("a long answer is cut, not sent whole", () => {
    expect(promptFailed(row, new Error("x".repeat(900)), false)).toBe(`Claude Code refused the message: ${"x".repeat(300)}`);
  });
});

describe("what the chat is on, under a failure on a model picked in it", () => {
  test("the word picked with what it stands for, and the way back", () => {
    const offered = [{ value: "default", name: "Default" }, { value: "fable", name: "Fable 5.1" }, { value: "plain" }];
    expect(pickedNote("fable", "Claude Code", offered)).toBe("This chat is on `fable` (Fable 5.1), picked here. `/model default` goes back to Claude Code's own.");
    // A word that is its own name, or one the list does not hold, is said alone.
    expect(pickedNote("plain", "Claude Code", offered)).toBe("This chat is on `plain`, picked here. `/model default` goes back to Claude Code's own.");
    expect(pickedNote("gone", "Codex", [])).toBe("This chat is on `gone`, picked here. `/model default` goes back to Codex's own.");
  });
});
