/**
 * What the shipped `coding-agents` skill holds an agent to when it hands work to a coding agent (0.7.17): a worktree
 * per task, cleaned up after, and a brief in English — whatever language the person wrote in — with a scope, a
 * "done when" and a handoff. A skill is read by a model, so its rules are behaviour, and held here like any other.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "../../../../content/skills/coding-agents/SKILL.md"), "utf8");

test("every task gets its own worktree, checked first and removed when finished", () => {
  expect(skill).toContain("Every task gets a git worktree and a branch of its own, always");
  expect(skill).toContain("git -C <repo> worktree list");
  expect(skill).toContain("git -C <repo> worktree remove");
  expect(skill).toContain("Never two coding agents in one worktree at once");
});

test("the brief is in English even when the person wrote in another language, with identifiers kept as written", () => {
  expect(skill).toContain("**Write it in English,\nalways**, even when the person wrote to you in Indonesian");
  expect(skill).toContain("Keep exactly as they are: code, identifiers, file paths, commands, error messages");
  expect(skill).toContain("You still answer the person in their own language.");
});

test("a brief has a scope, a check and a handoff — and is not sent without them", () => {
  for (const section of ["# Goal", "# Context", "# Scope", "# Constraints", "# Done when", "# Handoff"]) expect(skill).toContain(section);
  expect(skill).toContain("A brief without a scope and a \"done when\" is not ready to send");
});

// As one line: where Markdown wraps a sentence is not part of what it says.
const flat = skill.replace(/\s+/g, " ");

/**
 * Long work is a mission (0.8.12). The skill offered "a feature, a refactor, a failing test suite" to a background
 * `exec` from the chat and never named missions, which the TOOLS line (`WHEN_TO_START`) sends that work to; and its
 * worktree step made a second worktree inside a mission that already works in one.
 */
test("long work is drafted as a mission, and the person starts it", () => {
  expect(flat).toContain("**Long work is a mission.** Many files, many steps, anything that waits on CI or a long command");
  expect(flat).toContain("draft it with `mission`, as your TOOLS say");
  expect(flat).toContain("They start it, and you drive the CLI inside it");
  expect(flat).toContain("long work goes to it as a mission, with `agent` naming it");
});

test("in a mission the mission's folder is the CLI's working directory, and no worktree is added", () => {
  expect(flat).toContain("**In a mission, the mission's folder is the CLI's working directory**, its `cwd`");
  // The words the mission's page uses for it (`missions/page.ts`), so the agent finds the line it is pointed at.
  expect(flat).toContain("Its page names it (`Folder: …`)");
  expect(flat).toContain("make no worktree of your own");
  expect(flat).toContain("The rest of this step is for work outside a mission.");
  expect(flat.indexOf("**In a mission, the mission's folder")).toBeLessThan(flat.indexOf("git -C <repo> worktree add"));
});

test("a token sent in the chat is kept with secret_save; the CLI is one way of several", () => {
  expect(flat).toContain("Sent here, it reaches you as a `$TMP_SECRET_…` handle, never the value: keep it with `secret_save`");
  expect(flat).toContain("Or they add it on the dashboard's Secrets page or with `nouride secret set <name> --stdin` on this machine");
  expect(flat).toContain("Never print it, not even part of it.");
});

test("its own login is for a CLI it drives itself, never an agent's", () => {
  // `references/adding-an-agent.md` says never to run a CLI's login; this is the case it does not cover, said so.
  expect(flat).toContain("This signs in a CLI you drive yourself, in your own home.");
  expect(flat).toContain("An agent of this install that a CLI answers is signed in by the person, on that agent's Brain tab in the dashboard, never by you");
});
