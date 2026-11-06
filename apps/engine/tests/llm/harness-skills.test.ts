/**
 * What the harness tells an agent a skill is (0.7.27).
 *
 * It used to say "when you work something out that took effort and will recur, write it as a skill rather than only
 * answering" — and agents asked to save one task's steps wrote a skill named after the task. A prompt is behaviour, so
 * the words that carry the rule are asserted: a procedure for a kind of task, not one task; where a task stands and
 * facts about hosts, accounts and people go elsewhere.
 */

import { expect, test } from "bun:test";
import { renderMemory } from "@/modules/llm/prompt/harness-memory.ts";
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
