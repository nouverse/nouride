/**
 * Home's word of a coding CLI's update: only for a CLI that is installed, has a newer version out or is too old, and
 * has an agent working in it. A Claude Code two models behind was learned of from the model that was missing.
 */

import { describe, expect, test } from "bun:test";
import type { ScannedCli } from "@nouride/wire";
import { clisToUpdate, cliUpdateWords } from "@/commons/lib/cli-updates";

const cli = (id: string, name: string, standing: ScannedCli["standing"], installed = true): ScannedCli => ({ id, name, command: `${id}-acp`, install: "", login: true, installed, ...(standing ? { standing } : {}) });
const on = (...clis: string[]) => clis.map((id) => ({ external: { cli: id } }));

describe("the coding CLIs Home says have an update out", () => {
  const scanned = [
    cli("claude-code", "Claude Code", { standing: "update", offer: "0.107.0", offerUntested: true }),
    cli("codex", "Codex", { standing: "older", offer: "2.6.0" }),
    cli("mine", "Mine", { standing: "current" }),
    cli("ahead", "Ahead", { standing: "current", ahead: "9.9.9" }),
    cli("tried", "Tried", { standing: "newer" }),
  ];

  test("a newer version out, tested with this Nouride or not, and one too old: each where an agent works in it", () => {
    expect(clisToUpdate(scanned, on("claude-code", "codex", "mine", "ahead", "tried"), true)).toEqual([{ id: "claude-code", name: "Claude Code" }, { id: "codex", name: "Codex" }]);
  });

  test("none for a CLI no agent works in, one not installed, or one with nothing to install", () => {
    expect(clisToUpdate(scanned, on("mine"), true)).toEqual([]);
    expect(clisToUpdate(scanned, [{}, { external: undefined }], true)).toEqual([]);
    expect(clisToUpdate([cli("claude-code", "Claude Code", { standing: "update", offer: "0.107.0" }, false)], on("claude-code"), true)).toEqual([]);
    // Up to date, a newer CLI nothing carries yet, newer than tested: nothing to press, so nothing on Home.
    expect(clisToUpdate(scanned, on("ahead", "tried"), true)).toEqual([]);
  });

  test("none at all for someone who cannot have a CLI updated, whatever was read", () => {
    // Another page reads the same list for an operator, and it stays in the browser: Home says nothing of it to them.
    expect(clisToUpdate(scanned, on("claude-code", "codex"), false)).toEqual([]);
  });

  test("the words: the one CLI by name, or how many; nothing where there is none", () => {
    expect(cliUpdateWords([{ name: "Claude Code" }])).toBe("Claude Code update out");
    expect(cliUpdateWords([{ name: "Claude Code" }, { name: "Codex" }])).toBe("2 updates out");
    expect(cliUpdateWords([])).toBeNull();
  });
});
