import { describe, expect, test } from "bun:test";
import { normalizeCommand } from "@/modules/tools/builtins/exec.ts";

describe("normalizeCommand with a string", () => {
  test("a chain runs under bash rather than being refused", () => {
    expect(normalizeCommand("git add -A && git commit -m 'x'")).toEqual({
      argv: ["bash", "-lc", "git add -A && git commit -m 'x'"],
    });
  });

  test("quotes alone are enough to need a shell", () => {
    expect(normalizeCommand('git commit -m "two words"')).toEqual({
      argv: ["bash", "-lc", 'git commit -m "two words"'],
    });
  });

  test("a plain command runs its program directly", () => {
    expect(normalizeCommand("git status")).toEqual({ argv: ["git", "status"] });
  });

  test("the JSON text of an argv is read as the argv", () => {
    expect(normalizeCommand('["git", "status"]')).toEqual({ argv: ["git", "status"] });
  });

  test("a shell test starting with [ still reaches the shell", () => {
    expect(normalizeCommand("[ -f x ] && cat x")).toEqual({ argv: ["bash", "-lc", "[ -f x ] && cat x"] });
  });

  test("arrays are unchanged", () => {
    expect(normalizeCommand(["ls", "-la"])).toEqual({ argv: ["ls", "-la"] });
  });
});
