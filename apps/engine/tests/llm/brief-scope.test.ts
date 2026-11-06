/**
 * A brief bounds the work it hands over (0.7.25): a change asks for the change only, research is a brief of its own that
 * changes nothing, and every brief says when to stop and what to hand back.
 *
 * Live: "delete these three ZFS datasets", in a brief that also asked for the root cause and the options for a
 * permanent fix, with nothing on when to stop — fourteen minutes of kernel tracing on a production hypervisor. The same
 * words are where each kind of delegation is written: the harness's `delegate` lines, and `ask_agent`'s task.
 */

import { describe, expect, test } from "bun:test";
import { renderTools } from "@/modules/llm/prompt/harness-tools.ts";
import { createAskAgentTool } from "@/modules/tools/builtins/ask-agent.ts";

const RULES = [
  "A brief that changes or deletes something asks for that change only: research (a root cause, options for a fix) goes in a separate, read-only brief.",
  "Say when to stop and report (after two failed attempts, or at anything unexpected) and what to hand back.",
];

describe("the brief's scope", () => {
  test("is in the harness's delegation lines", () => {
    const text = renderTools({ ctx: { harness: { maxToolIterations: 8, approvalAvailable: true } }, toolNames: ["delegate"], gated: [], free: ["delegate"] } as never).join("\n");
    for (const rule of RULES) expect(text).toContain(rule);
  });

  test("is in what `ask_agent` asks of its task", () => {
    const tool = createAskAgentTool({ peers: () => ["nero"], run: async () => ({}) as never });
    const task = (tool.definition.parameters as { properties: { task: { description: string } } }).properties.task.description;
    for (const rule of RULES) expect(task).toContain(rule);
  });
});
