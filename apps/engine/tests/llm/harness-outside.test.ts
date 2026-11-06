/**
 * What the agent is told before a memory write waits for a person, after outside content (S13).
 *
 * The gate's reason and the tool result said it, but only once the call was made — and an agent that did not expect the
 * pause retried it, or apologised, instead of telling the person what it wanted to keep. So the harness says it first,
 * where the gate can hold a call, and nowhere else.
 */

import { describe, expect, test } from "bun:test";
import type { ApprovalLevel } from "@nouride/shared";
import { renderMemory } from "@/modules/llm/prompt/harness-memory.ts";
import type { HarnessView } from "@/modules/llm/prompt/types.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

const MEMORY_TOOLS = ["memory_read", "memory_write", "person_record", "person_notes"];

function memory(toolNames: string[], harness: { approvals?: ApprovalLevel; approvalAvailable?: boolean; helper?: boolean } = {}): string {
  const view = {
    ctx: { harness: { approvalAvailable: true, approvalRequired: [], ...harness }, tools: toolNames.map((name) => ({ name })) },
    toolNames,
    gated: [],
    free: toolNames,
  } as unknown as HarnessView;
  return renderMemory(view).join("\n");
}

const PAUSE = "Once this turn has read outside content";

describe("the pause after outside content", () => {
  test("says what outside content is, that the write waits for a person, and what to do then", () => {
    const text = memory(MEMORY_TOOLS);
    const line = text.split("\n").find((l) => l.includes(PAUSE)) ?? "";
    for (const source of ["a forwarded message", "a webhook's payload", "a fetched page", "an MCP server's answer", "a file somebody sent"]) {
      expect(line).toContain(source);
    }
    expect(line).toContain("`memory_write`, `person_record` or a change through `person_notes` waits for a person to say yes");
    // How to act: say what and why — not a retry, not an apology.
    expect(line).toContain("say in one line what you want to save and why");
    expect(line).toContain("Do not try it again and do not apologise.");
  });

  test("names only the writes this agent has", () => {
    const line = memory(["memory_read", "memory_write"]).split("\n").find((l) => l.includes(PAUSE)) ?? "";
    expect(line).toContain("`memory_write` waits for a person");
    expect(line).not.toContain("person_record");
  });

  test("is absent where the gate cannot hold a call: no such tool, an approval level of none, a helper", () => {
    expect(memory(["memory_read", "read"])).not.toContain(PAUSE);
    expect(memory(MEMORY_TOOLS, { approvals: "trusted" })).not.toContain(PAUSE);
    expect(memory(MEMORY_TOOLS, { helper: true })).not.toContain(PAUSE);
    // At `balanced` the gate still asks — the class is `runtime-self`, which that level keeps a question.
    expect(memory(MEMORY_TOOLS, { approvals: "balanced" })).toContain(PAUSE);
  });

  test("says the write is refused where nobody can be asked", () => {
    expect(memory(MEMORY_TOOLS, { approvalAvailable: false })).toContain("nobody can say it here, so it is refused");
    expect(memory(MEMORY_TOOLS)).not.toContain("so it is refused");
  });

  test("names every tool the gate holds — the same set that carries `keepsInPrompt`", () => {
    // The prompt sees definitions, not tools, so the harness keeps its own list; this holds it to the flags.
    const stub = (() => undefined) as never;
    const tools = createBuiltinTools({
      security: DEFAULT_CONFIG.security,
      memory: {} as never,
      people: {} as never,
      sessionStatus: stub,
    });
    const flagged = [...tools.values()].filter((tool) => tool.keepsInPrompt).map((tool) => tool.definition.name);
    expect(flagged.sort()).toEqual(["memory_write", "person_notes", "person_record"]);
    const line = memory([...tools.keys()]).split("\n").find((l) => l.includes(PAUSE)) ?? "";
    for (const name of flagged) expect(line).toContain(`\`${name}\``);
  });
});
