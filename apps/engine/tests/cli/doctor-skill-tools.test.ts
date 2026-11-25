/**
 * `doctor`'s line for a skill an agent carries and cannot run: which tools are missing, and whose they are.
 * One agent "does not have" them and several "do not": the line once read "which nora do not have".
 */

import { expect, test } from "bun:test";
import { skillToolsCheck } from "@/cli/commands/doctor-checks.ts";

const agent = (id: string, missingTools: string[], enabled = true) => ({ id, enabled, missingTools });

test("one agent short of a tool: named alone, with what it does not have", () => {
  expect(skillToolsCheck({ name: "domain-management", agents: [agent("nora", ["exec"]), agent("nouva", [])] })).toEqual({
    level: "warn",
    message: 'skill "domain-management" needs exec, which nora does not have',
    hint: "Add the tool to that agent's `[tools] enabled`, or switch the skill off for it: `nouride skills off domain-management <agent>`.",
  });
});

test("several agents short: each named, and only the tools that are missing, once each and in order", () => {
  expect(skillToolsCheck({ name: "google-workspace", agents: [agent("nora", ["read", "exec"]), agent("nox", ["exec"])] })?.message).toBe(
    'skill "google-workspace" needs exec, read, which nora, nox do not have',
  );
});

test("nothing to say where no agent with the skill on is short of a tool", () => {
  expect(skillToolsCheck({ name: "notes", agents: [agent("nora", []), agent("nox", ["exec"], false)] })).toBeNull();
  expect(skillToolsCheck({ name: "notes" })).toBeNull();
});
