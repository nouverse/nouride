/**
 * What the harness tells an agent a skill is (0.7.27).
 *
 * It used to say "when you work something out that took effort and will recur, write it as a skill rather than only
 * answering" — and agents asked to save one task's steps wrote a skill named after the task. A prompt is behaviour, so
 * the words that carry the rule are asserted: a procedure for a kind of task, not one task; where a task stands and
 * facts about hosts, accounts and people go elsewhere.
 */

import { expect, test } from "bun:test";
import { renderCli } from "@/modules/llm/prompt/harness-cli.ts";
import { renderMemory } from "@/modules/llm/prompt/harness-memory.ts";
import { renderSkillPolicy } from "@/modules/llm/prompt/harness-skills.ts";
import type { HarnessView } from "@/modules/llm/prompt/types.ts";

function memory(toolNames: string[]): string {
  const view = {
    ctx: { harness: { approvalAvailable: true, approvalRequired: [] }, tools: toolNames.map((name) => ({ name })) },
    toolNames,
    gated: [],
    free: toolNames,
  } as unknown as HarnessView;
  return renderMemory(view).join("\n");
}

test("a skill is the procedure for a kind of task — not one task, not where it stands, not facts", () => {
  const text = memory(["skill_create", "memory_write", "notes"]);
  expect(text).toContain("`skill_create`: write down the procedure for a kind of task, so you have it next time");
  expect(text).toContain("A skill is the procedure for a kind of task: the steps for the next time work like this comes up, on another task.");
  expect(text).toContain("Write one when you worked out such a procedure and it will recur, not for one task.");
  expect(text).toContain("Where this task stands goes in its work notes; facts about hosts, accounts and people go in memory.");
  expect(text).not.toContain("rather than only answering");
});

test("without work notes, where a task stands goes in memory", () => {
  expect(memory(["skill_create", "memory_write"])).toContain("Where this task stands goes in memory;");
});

test("the skill tools are named as the model can call them: one entry and its action where they are sent as one", () => {
  // Two or more of them are sent as the one `skill` tool, so a line naming `skill_create` would name a tool the model
  // was not sent.
  const folded = memory(["skill_create", "skill_toggle", "memory_write", "notes"]);
  expect(folded).toContain("- `skill` with action `create`: write down the procedure for a kind of task, so you have it next time");
  expect(folded).toContain("- `skill` with action `toggle`: see every skill that exists and switch one on or off for yourself");
  expect(folded).not.toContain("`skill_create`");
  expect(folded).not.toContain("`skill_toggle`");
  // One of them alone is sent as itself, and named so.
  expect(memory(["skill_toggle", "memory_write"])).toContain("- `skill_toggle`: see every skill that exists");
});

/** The parts of a view the CLI and the skill sections read. */
const view = (toolNames: string[]): HarnessView =>
  ({
    ctx: {
      harness: { approvalAvailable: true, approvalRequired: [], installDir: "/srv/nouride", commands: [] },
      tools: toolNames.map((name) => ({ name })),
      agent: { config: { id: "nouva", skillRoots: [], tools: { enabled: toolNames } }, skills: [] },
    },
    toolNames,
    gated: [],
    free: toolNames,
  }) as unknown as HarnessView;

test("the CLI section sends a skill's switch to the tool as the model can call it", () => {
  expect(renderCli(view(["nouride", "skill_toggle", "skill_create"])).join("\n")).toContain("a skill goes to `skill` with action `toggle`");
  expect(renderCli(view(["nouride", "skill_toggle"])).join("\n")).toContain("a skill goes to `skill_toggle`");
});

test("looking on the hubs, and asking for a project's skills, name the entry and its actions where the tools are folded", () => {
  const folded = renderSkillPolicy(view(["read", "skill_search", "skill_install", "skill_root"])).join("\n");
  expect(folded).toContain("look on the public hubs first: `skill` with action `search`, then `skill` with action `install` with the ref it gives");
  expect(folded).toContain("ask with `skill` with action `root` (add, the project's path,");
  const alone = renderSkillPolicy(view(["read", "skill_root"])).join("\n");
  expect(alone).toContain("ask with `skill_root` (add, the project's path,");
});
