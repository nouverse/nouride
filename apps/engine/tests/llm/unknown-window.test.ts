/**
 * A model whose window nothing knows is budgeted at a 32k guess. Looked at before changing
 * anything: an agent's prompt and tool schemas alone come to about 31k on the live box, so at that guess the history
 * budget is nothing, and the in-turn trim cleared every tool result — the one the model had just asked for too, which it
 * then asked for again. The oldest go first now, and a result the model has not read yet is never cleared.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@nouride/shared";
import { ceilingsAt } from "@/modules/llm/executor/prepare.ts";
import { trimToolResults, TRIMMED_TOOL_PREFIX } from "@/modules/llm/context.ts";

/** Nouva's request on the live box, 2026-10-25: about 31k of prompt and tool schemas before any history. */
const LIVE_OVERHEAD = { promptTokens: 20_000, toolsTokens: 11_000 };

const call = (id: string): ChatMessage => ({ role: "assistant", content: "", toolCalls: [{ id, name: "read", arguments: { path: id } }], timestamp: 1 });
const result = (id: string): ChatMessage => ({ role: "tool", toolCallId: id, content: `${id}: ${"x".repeat(4_000)}`, timestamp: 1 });

describe("a window nobody knows", () => {
  test("at the 32k guess, a live agent's prompt and tools leave the history nothing — the report, confirmed", () => {
    const ceilings = ceilingsAt(
      {
        contextWindow: 32_000,
        maxContextRatio: 0.8,
        ...LIVE_OVERHEAD,
        maxOutputTokens: 8_192,
        compactAtRatio: 0.9,
        totalLimit: { tokens: 160_000, source: "model" },
        summaryModel: "m",
        summarizerWindow: 32_000,
      },
      1,
    );
    expect(ceilings.budget).toBe(0);
    expect(ceilings.compactAt).toBe(0);
  });

  test("at that budget the older results are cleared, and the ones the model has not read yet are kept", () => {
    const turn: ChatMessage[] = [{ role: "user", content: "read them", timestamp: 1 }, call("a"), result("a"), call("b"), result("b"), call("c"), result("c")];
    const after = trimToolResults(turn, { maxTokens: 0, targetTokens: 0, keepRecent: 3 }).messages;
    const said = after.filter((message) => message.role === "tool").map((message) => String(message.content));
    expect(said[0]).toStartWith(TRIMMED_TOOL_PREFIX);
    expect(said[1]).toStartWith(TRIMMED_TOOL_PREFIX);
    expect(said[2]).toStartWith("c: ");
  });
});
