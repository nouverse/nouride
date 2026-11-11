/**
 * When the `/` menu opens, and what it offers.
 *
 * Both halves are the same rule seen from two sides: the menu belongs to the *command word*. It opens
 * while that word is being typed and closes the moment the message becomes a message — because a
 * composer that keeps a menu open over `/model gpt-5.6-luna` is a composer whose Enter key does
 * something different from what the person typing expects.
 */

import { describe, expect, test } from "bun:test";
import {
  applyCommand,
  matchCommands,
  slashToken,
} from "../src/commons/components/chat/SlashMenu.tsx";
import type { SlashCommand } from "@nouride/wire";

const COMMANDS: SlashCommand[] = [
  { command: "/help", description: "Show what I can do" },
  { command: "/new", description: "Start a fresh conversation" },
  { command: "/approvals", description: "Set the approval level" },
  { command: "/auto", description: "Approve everything from me" },
  { command: "/model", description: "Switch the model for this chat" },
];

describe("whether the menu is open at all", () => {
  test("a bare slash offers everything", () => {
    expect(slashToken("/")).toBe("/");
    expect(matchCommands(COMMANDS, "/")).toHaveLength(COMMANDS.length);
  });

  test("a half-typed command still counts", () => {
    expect(slashToken("/ne")).toBe("/ne");
  });

  test("a space ends it — the word is finished, the message has begun", () => {
    // `/model gpt-5.6-luna` is a command being *used*, and its Enter has to send.
    expect(slashToken("/model gpt-5.6-luna")).toBeNull();
    expect(slashToken("/new ")).toBeNull();
  });

  test("ordinary text never opens it", () => {
    expect(slashToken("what is 2/3 of 60?")).toBeNull();
    expect(slashToken("")).toBeNull();
  });
});

describe("what it offers", () => {
  test("prefix matches come first", () => {
    const found = matchCommands(COMMANDS, "/a");
    expect(found[0]?.command).toBe("/approvals");
    expect(found[1]?.command).toBe("/auto");
  });

  test("the description is searched too, so the word somebody reaches for finds the command", () => {
    // Typing what the command *does* rather than what it is called: nobody remembers that starting
    // over is `/new` rather than `/reset`.
    const found = matchCommands(COMMANDS, "/fresh");
    expect(found.map((entry) => entry.command)).toEqual(["/new"]);
  });

  test("a name match outranks a description match", () => {
    // `/auto` is named for the word; `/approvals` merely describes it. The one being typed wins.
    const found = matchCommands(COMMANDS, "/auto");
    expect(found[0]?.command).toBe("/auto");
  });

  test("a word nothing matches offers nothing, rather than everything", () => {
    expect(matchCommands(COMMANDS, "/zzz")).toHaveLength(0);
  });
});

/**
 * What choosing one does to the box.
 *
 * A command is the first word of the message or it is not a command at all, so this cannot be an
 * insertion at the caret — and the obvious alternative, replacing the box, quietly eats whatever was
 * being written. Nothing typed is ever lost here; it becomes the argument.
 */
describe("picking a command", () => {
  test("leaves a trailing space, so an argument is one keystroke away", () => {
    expect(applyCommand("", "/model")).toBe("/model ");
    expect(applyCommand("/mod", "/model")).toBe("/model ");
  });

  test("keeps what was already typed, as the argument", () => {
    // Type the model name, then reach for the command — the order people actually work in.
    expect(applyCommand("gpt-5.6-luna", "/model")).toBe("/model gpt-5.6-luna");
  });

  test("swaps an existing command word rather than stacking a second one", () => {
    expect(applyCommand("/model gpt-5.6-luna", "/prompt")).toBe("/prompt gpt-5.6-luna");
    expect(applyCommand("/approve always", "/deny")).toBe("/deny always");
  });
});
